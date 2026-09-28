/**
 * GitRefSyncAdapter — SyncPort over Git refs (refs/medha/memory), spec §7.2.
 *
 * Stores calibrated versioned snapshots (schemaVersion: 1) inside git object storage
 * on dedicated refs without polluting working trees or checking out branches.
 */

import { execFile } from 'node:child_process';
import {
  type Context,
  CURRENT_MEMORY_SCHEMA_VERSION,
  InvalidArgumentError,
  type MemorySnapshotV1,
  migrateSnapshot,
  type PullResult,
  type PushResult,
  type ReconcileResult,
  type StorePort,
  type SyncPort,
  type SyncState,
  type SyncStatus,
  serializeSnapshot,
  UnexpectedFailureError,
} from '@cntxt-labs/medha-core';
import { mergeEpisodes } from './merge.ts';

export const DEFAULT_MEDHA_REF = 'refs/medha/memory';

/**
 * The default ref up to 0.5.x. An adapter on the default ref still *reads* it (pull, peek, status)
 * so evidence pushed by an older medha is not stranded, but only ever writes {@link DEFAULT_MEDHA_REF}.
 */
export const LEGACY_MEDHA_REF = 'refs/sutra/medha/memory';

/**
 * @deprecated Hard-deprecated. Use DEFAULT_MEDHA_REF ('refs/medha/memory') instead.
 */
export const DEFAULT_SAGE_REF = 'refs/sutra/sage/memory';
export const DEFAULT_REMOTE = 'origin';

/**
 * How the adapter reaches its remote:
 * - `named`: a remote configured in this repo (`git remote add team <url>`).
 * - `location`: a path or URL passed directly, which git fetches and pushes without configuring.
 * - `none`: the default remote is not configured, so sync is local-ref only (not an error).
 */
export type RemoteTarget =
  | { readonly kind: 'named'; readonly remote: string; readonly url: string }
  | { readonly kind: 'location'; readonly remote: string }
  | { readonly kind: 'none' };

/** A path or URL rather than a remote name: git remote names cannot contain these. */
export function isRemoteLocation(remote: string): boolean {
  return /[/\\:]/.test(remote) || remote.startsWith('.') || remote.startsWith('~');
}

/** git's own stderr for a failed `runGit`, which is where it says *why* (hook output, rejection). */
function gitStderr(failure: unknown): string {
  if (failure instanceof UnexpectedFailureError) {
    const stderr = failure.context.stderr;
    if (typeof stderr === 'string' && stderr !== '') return stderr;
  }
  return failure instanceof Error ? failure.message : String(failure);
}

/** A fetch of a ref the remote simply does not have yet: nothing to pull, not a failure. */
function isMissingRemoteRef(stderr: string): boolean {
  return /couldn't find remote ref/i.test(stderr);
}

export interface GitExecResult {
  stdout: string;
  stderr: string;
}

export interface GitRefSyncOptions {
  readonly store: StorePort;
  readonly rootDir: string;
  readonly ref?: string | undefined;
  readonly remote?: string | undefined;
}

export class GitRefSyncAdapter implements SyncPort {
  readonly name = 'git-ref';
  readonly store: StorePort;
  readonly rootDir: string;
  readonly ref: string;
  readonly remote: string;
  /** Whether the caller named the remote. An unconfigured *default* remote means local-only. */
  readonly remoteExplicit: boolean;
  /** Extra refs read (never written) alongside `ref`: the pre-0.6 default, when on the default. */
  readonly readRefs: readonly string[];

  constructor(options: GitRefSyncOptions) {
    this.store = options.store;
    this.rootDir = options.rootDir;
    if (options.ref === DEFAULT_SAGE_REF) {
      // biome-ignore lint/suspicious/noConsole: Hard deprecation warning
      console.warn(
        `[medha] DEPRECATION WARNING: "${DEFAULT_SAGE_REF}" is hard-deprecated. Use DEFAULT_MEDHA_REF ("${DEFAULT_MEDHA_REF}") instead.`,
      );
    }
    this.ref = options.ref || DEFAULT_MEDHA_REF;
    this.remote = options.remote || DEFAULT_REMOTE;
    this.remoteExplicit = Boolean(options.remote);
    this.readRefs = options.ref ? [] : [LEGACY_MEDHA_REF];
  }

  /**
   * Resolve `remote` to something git can reach. A path or URL is used as-is; a name must be
   * configured in this repo. A name the caller passed that is not configured is an error rather than
   * a silent local-only sync, which is how a path `--remote` used to report `ok` with nothing
   * pulled.
   */
  async resolveRemote(remote = this.remote): Promise<RemoteTarget> {
    const url = await this.getRemoteUrl(remote);
    if (url !== null) return { kind: 'named', remote, url };
    if (isRemoteLocation(remote)) return { kind: 'location', remote };
    if (this.remoteExplicit) {
      throw new InvalidArgumentError(
        'remote',
        `a git remote configured in this repository (add it with 'git remote add ${remote} <url>'), or a path or URL`,
        remote,
      );
    }
    return { kind: 'none' };
  }

  /** Run a git command safely in rootDir with non-interactive flags. */
  async runGit(args: string[], stdinInput?: string): Promise<GitExecResult> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        'git',
        args,
        {
          cwd: this.rootDir,
          maxBuffer: 32 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new UnexpectedFailureError(`git ${args[0]}`, error, {
                context: { args, stderr: stderr.trim() },
              }),
            );
          } else {
            resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
          }
        },
      );

      if (stdinInput !== undefined && child.stdin) {
        child.stdin.write(stdinInput);
        child.stdin.end();
      }
    });
  }

  async isGitRepo(): Promise<boolean> {
    try {
      const { stdout } = await this.runGit(['rev-parse', '--is-inside-work-tree']);
      return stdout === 'true';
    } catch {
      return false;
    }
  }

  async getRefCommit(ref = this.ref): Promise<string | null> {
    try {
      const { stdout } = await this.runGit(['rev-parse', '--verify', ref]);
      return stdout || null;
    } catch {
      return null;
    }
  }

  async getRemoteRefCommit(remote = this.remote, ref = this.ref): Promise<string | null> {
    try {
      const { stdout } = await this.runGit(['ls-remote', remote, ref]);
      if (!stdout) return null;
      const [sha] = stdout.split(/\s+/);
      return sha || null;
    } catch {
      return null;
    }
  }

  async getMergeBaseCommit(commitA: string, commitB: string): Promise<string | null> {
    try {
      const { stdout } = await this.runGit(['merge-base', commitA, commitB]);
      return stdout || null;
    } catch {
      return null;
    }
  }

  async getRemoteUrl(remote = this.remote): Promise<string | null> {
    try {
      const { stdout } = await this.runGit(['remote', 'get-url', remote]);
      return stdout || null;
    } catch {
      return null;
    }
  }

  async readSnapshotFromRef(refOrSha = this.ref): Promise<MemorySnapshotV1 | null> {
    // 1. Try reading snapshot.json
    try {
      const { stdout } = await this.runGit(['cat-file', '-p', `${refOrSha}:snapshot.json`]);
      if (stdout) {
        return migrateSnapshot(JSON.parse(stdout));
      }
    } catch (failure) {
      void failure;
    }

    // 2. Try reading episodes.jsonl fallback
    try {
      const { stdout } = await this.runGit(['cat-file', '-p', `${refOrSha}:episodes.jsonl`]);
      if (stdout) {
        const episodes = stdout
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l));
        return {
          schemaVersion: 1,
          asOf: Date.now(),
          entities: [],
          episodes,
        };
      }
    } catch (failure) {
      void failure;
    }

    return null;
  }

  async writeSnapshotToRef(
    snapshot: MemorySnapshotV1,
    message = 'Medha evidential-memory sync',
    ref = this.ref,
    parents?: string[],
  ): Promise<string> {
    const jsonStr = serializeSnapshot(snapshot);

    // 1. Create blob
    const { stdout: blobSha } = await this.runGit(['hash-object', '-w', '--stdin'], jsonStr);

    // 2. Create tree with snapshot.json
    const treeInput = `100644 blob ${blobSha}\tsnapshot.json\n`;
    const { stdout: treeSha } = await this.runGit(['mktree'], treeInput);

    // 3. Build commit
    const explicitParents =
      parents && parents.length > 0 ? Array.from(new Set(parents.filter(Boolean))) : null;

    const buildCommit = async (autoParent: string | null): Promise<string> => {
      const args = ['commit-tree', treeSha];
      if (explicitParents) {
        for (const p of explicitParents) args.push('-p', p);
      } else if (autoParent) {
        args.push('-p', autoParent);
      }
      args.push('-m', message);
      const { stdout } = await this.runGit(args);
      return stdout;
    };

    const swapIn = async (autoParent: string | null): Promise<string> => {
      const sha = await buildCommit(autoParent);
      const updateArgs = ['update-ref', ref, sha];
      if (!explicitParents && autoParent) {
        updateArgs.push(autoParent);
      }
      await this.runGit(updateArgs);
      return sha;
    };

    if (explicitParents) {
      return await swapIn(null);
    }

    const expectedParent = await this.getRefCommit(ref);
    try {
      return await swapIn(expectedParent);
    } catch {
      const currentSha = await this.getRefCommit(ref);
      return await swapIn(currentSha);
    }
  }

  getTrackingRef(remote = this.remote, ref = this.ref): string {
    const suffix = ref.startsWith('refs/') ? ref.slice('refs/'.length) : ref;
    if (/^[a-zA-Z0-9_-]+$/.test(remote)) {
      return `refs/remotes/${remote}/${suffix}`;
    }
    let hash = 0;
    for (let i = 0; i < remote.length; i++) {
      hash = ((hash << 5) - hash + remote.charCodeAt(i)) | 0;
    }
    const hexHash = Math.abs(hash).toString(16);
    const sanitized = remote
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
    return `refs/remotes/path_${sanitized}_${hexHash}/${suffix}`;
  }

  async fetchRemoteRef(
    remote = this.remote,
    ref = this.ref,
  ): Promise<{
    ok: boolean;
    trackingRef: string;
    commit?: string;
    error?: string;
    /** The remote does not have `ref` (yet). Not an error for a pull. */
    missing?: boolean;
  }> {
    if (ref === DEFAULT_SAGE_REF) {
      // biome-ignore lint/suspicious/noConsole: Hard deprecation warning
      console.warn(
        `[medha] DEPRECATION WARNING: "${DEFAULT_SAGE_REF}" is hard-deprecated. Use DEFAULT_MEDHA_REF ("${DEFAULT_MEDHA_REF}") instead.`,
      );
    }
    const trackingRef = this.getTrackingRef(remote, ref);
    try {
      await this.runGit(['fetch', remote, `${ref}:${trackingRef}`]);
      const commit = await this.getRefCommit(trackingRef);
      return { ok: true, trackingRef, ...(commit ? { commit } : {}) };
    } catch (e) {
      const stderr = gitStderr(e);
      if (isMissingRemoteRef(stderr)) {
        return { ok: true, trackingRef, missing: true };
      }
      return { ok: false, trackingRef, error: `git fetch from '${remote}' failed:\n${stderr}` };
    }
  }

  async pushRemoteRef(
    remote = this.remote,
    ref = this.ref,
    force = false,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const pushRefSpec = force ? `+${ref}:${ref}` : `${ref}:${ref}`;
      await this.runGit(['push', remote, pushRefSpec]);
      return { ok: true };
    } catch (e) {
      // git's stderr is the reason: a hook's output, `! [rejected] ... (fetch first)`, auth. The
      // closing "failed to push some refs" line alone says nothing, so pass all of it through.
      return { ok: false, error: `git push to '${remote}' failed:\n${gitStderr(e)}` };
    }
  }

  async status(_context?: Context): Promise<SyncStatus> {
    const isGit = await this.isGitRepo();
    const localStates = await this.store.list();
    const localCount = localStates.length;

    if (!isGit) {
      return {
        state: 'uninitialized',
        localCount,
        ref: this.ref,
        message: 'Directory is not a git repository',
      };
    }

    let target: RemoteTarget;
    try {
      target = await this.resolveRemote();
    } catch (failure) {
      return {
        state: 'uninitialized',
        localCount,
        ref: this.ref,
        message: gitStderr(failure),
      };
    }
    const remoteName = target.kind === 'none' ? undefined : target.remote;
    // Before the first push on the current default ref, report the legacy ref's state instead of
    // 'uninitialized', so an upgrade does not look like the evidence vanished.
    let ref = this.ref;
    for (const candidate of [this.ref, ...this.readRefs]) {
      const hasLocal = (await this.getRefCommit(candidate)) !== null;
      const hasRemote =
        remoteName !== undefined && (await this.getRemoteRefCommit(remoteName, candidate)) !== null;
      if (hasLocal || hasRemote) {
        ref = candidate;
        break;
      }
    }
    const localCommit = (await this.getRefCommit(ref)) || undefined;
    const remoteCommit =
      remoteName === undefined
        ? undefined
        : (await this.getRemoteRefCommit(remoteName, ref)) || undefined;
    const remoteUrl =
      target.kind === 'named' ? target.url : target.kind === 'location' ? target.remote : undefined;

    if (!localCommit && !remoteCommit) {
      return {
        state: 'uninitialized',
        localCount,
        ref: this.ref,
        ...(remoteUrl ? { remoteUrl } : {}),
      };
    }

    let state: SyncState = 'synced';
    if (!localCommit && remoteCommit) {
      state = 'behind';
    } else if (localCommit && !remoteCommit) {
      state = 'ahead';
    } else if (localCommit && remoteCommit) {
      if (localCommit === remoteCommit) {
        state = 'synced';
      } else {
        const base = await this.getMergeBaseCommit(localCommit, remoteCommit);
        if (base === localCommit) {
          state = 'behind';
        } else if (base === remoteCommit) {
          state = 'ahead';
        } else {
          state = 'diverged';
        }
      }
    }

    return {
      state,
      localCount,
      localHead: localCommit,
      remoteHead: remoteCommit,
      ref,
      ...(remoteUrl ? { remoteUrl } : {}),
      ...(ref === this.ref
        ? {}
        : { message: `reading legacy ref ${ref}; the next push writes ${this.ref}` }),
    };
  }

  async hasRemote(remote = this.remote): Promise<boolean> {
    try {
      return (await this.resolveRemote(remote)).kind !== 'none';
    } catch {
      return false;
    }
  }

  /**
   * Every snapshot this adapter reads: for `ref` and each legacy read ref, the remote's copy when
   * there is a remote, else the local one. A remote that cannot be reached is an error; a remote
   * that simply lacks the ref contributes nothing.
   */
  private async readSnapshots(): Promise<
    { ok: true; snapshots: MemorySnapshotV1[] } | { ok: false; error: string }
  > {
    let target: RemoteTarget;
    try {
      target = await this.resolveRemote();
    } catch (failure) {
      return { ok: false, error: gitStderr(failure) };
    }
    const snapshots: MemorySnapshotV1[] = [];
    for (const ref of [this.ref, ...this.readRefs]) {
      let snapshot: MemorySnapshotV1 | null = null;
      if (target.kind !== 'none') {
        const fetched = await this.fetchRemoteRef(target.remote, ref);
        if (!fetched.ok) {
          return { ok: false, error: fetched.error ?? `git fetch from '${target.remote}' failed` };
        }
        if (!fetched.missing) {
          snapshot = await this.readSnapshotFromRef(fetched.trackingRef);
        }
      }
      snapshot ??= await this.readSnapshotFromRef(ref);
      if (snapshot) snapshots.push(snapshot);
    }
    return { ok: true, snapshots };
  }

  async peek(_context?: Context): Promise<MemorySnapshotV1 | null> {
    const isGit = await this.isGitRepo();
    if (!isGit) return null;
    const read = await this.readSnapshots();
    return read.ok ? (read.snapshots[0] ?? null) : null;
  }

  async pull(_context?: Context): Promise<PullResult> {
    const isGit = await this.isGitRepo();
    const localStates = await this.store.list();

    if (!isGit) {
      return {
        ok: false,
        updated: false,
        pulledCount: 0,
        localTotal: localStates.length,
        error: 'Not a git repository',
      };
    }

    const read = await this.readSnapshots();
    if (!read.ok) {
      return {
        ok: false,
        updated: false,
        pulledCount: 0,
        localTotal: localStates.length,
        error: read.error,
      };
    }

    // Merge episodes from every snapshot read (the current ref, plus the legacy one on upgrade).
    const localEpisodes = await this.store.episodes();
    let mergedEpisodes = localEpisodes;
    for (const snapshot of read.snapshots) {
      if (snapshot.episodes && snapshot.episodes.length > 0) {
        mergedEpisodes = mergeEpisodes(mergedEpisodes, snapshot.episodes);
      }
    }
    let updated = false;
    let pulledCount = 0;
    if (mergedEpisodes.length !== localEpisodes.length) {
      await this.store.replaceLog(mergedEpisodes);
      await this.store.rebuild();
      updated = true;
      pulledCount = mergedEpisodes.length - localEpisodes.length;
    }

    const updatedStates = await this.store.list();
    return {
      ok: true,
      updated,
      pulledCount,
      localTotal: updatedStates.length,
    };
  }

  async push(context?: Context): Promise<PushResult> {
    const isGit = await this.isGitRepo();
    if (!isGit) {
      return { ok: false, pushedCount: 0, error: 'Not a git repository' };
    }

    try {
      const entities = await this.store.list();
      const episodes = await this.store.episodes();
      const asOf = context?.now ?? Date.now();

      const snapshot: MemorySnapshotV1 = {
        schemaVersion: CURRENT_MEMORY_SCHEMA_VERSION,
        asOf,
        registries: this.store.registries,
        entities,
        episodes: episodes.length > 0 ? episodes : undefined,
      };

      const target = await this.resolveRemote();
      const remoteExists = target.kind !== 'none';
      // First push on the default ref after an upgrade continues the legacy ref's history.
      let localCommit = await this.getRefCommit(this.ref);
      for (const legacy of this.readRefs) {
        localCommit ??= await this.getRefCommit(legacy);
      }
      const trackingRef = this.getTrackingRef(this.remote, this.ref);
      const remoteCommit = remoteExists ? await this.getRefCommit(trackingRef) : null;
      const parents: string[] = [];
      if (localCommit) parents.push(localCommit);
      if (remoteCommit && remoteCommit !== localCommit) parents.push(remoteCommit);

      const commit = await this.writeSnapshotToRef(
        snapshot,
        'Medha memory push',
        this.ref,
        parents.length > 0 ? parents : undefined,
      );

      // Push to remote ref if remote exists (errors captured in result)
      if (remoteExists) {
        const pushRes = await this.pushRemoteRef(this.remote, this.ref, false);
        if (!pushRes.ok) {
          return {
            ok: false,
            pushedCount: 0,
            error: pushRes.error ?? `git push to '${this.remote}' failed`,
          };
        }
      }

      return {
        ok: true,
        pushedCount: entities.length,
        commit,
      };
    } catch (err) {
      return {
        ok: false,
        pushedCount: 0,
        error: gitStderr(err),
      };
    }
  }

  async reconcile(context?: Context): Promise<ReconcileResult> {
    const pullRes = await this.pull(context);
    if (!pullRes.ok) {
      return {
        ok: false,
        pulledCount: 0,
        pushedCount: 0,
        totalCount: pullRes.localTotal,
        error: pullRes.error,
      };
    }
    const pushRes = await this.push(context);

    return {
      ok: pushRes.ok,
      pulledCount: pullRes.pulledCount,
      pushedCount: pushRes.pushedCount,
      totalCount: pullRes.localTotal,
      commit: pushRes.commit,
      error: pushRes.error,
    };
  }
}
