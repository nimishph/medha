/**
 * GitRefSyncAdapter — SyncPort over Git refs (refs/sutra/medha/memory), spec §7.2.
 *
 * Stores calibrated versioned snapshots (schemaVersion: 1) inside git object storage
 * on dedicated refs without polluting working trees or checking out branches.
 */

import { execFile } from 'node:child_process';
import {
  type Context,
  CURRENT_MEMORY_SCHEMA_VERSION,
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

export const DEFAULT_MEDHA_REF = 'refs/sutra/medha/memory';

/**
 * @deprecated Hard-deprecated. Use DEFAULT_MEDHA_REF ('refs/sutra/medha/memory') instead.
 */
export const DEFAULT_SAGE_REF = 'refs/sutra/sage/memory';
export const DEFAULT_REMOTE = 'origin';

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
    message = 'Sage evidential-memory sync',
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
  ): Promise<{ ok: boolean; trackingRef: string; commit?: string; error?: string }> {
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
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, trackingRef, error: msg };
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
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
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

    const localCommit = (await this.getRefCommit(this.ref)) || undefined;
    const remoteCommit = (await this.getRemoteRefCommit(this.remote, this.ref)) || undefined;
    const remoteUrl = (await this.getRemoteUrl(this.remote)) || undefined;

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
      ref: this.ref,
      ...(remoteUrl ? { remoteUrl } : {}),
    };
  }

  async hasRemote(remote = this.remote): Promise<boolean> {
    try {
      const url = await this.getRemoteUrl(remote);
      return url !== null;
    } catch {
      return false;
    }
  }

  async peek(_context?: Context): Promise<MemorySnapshotV1 | null> {
    const isGit = await this.isGitRepo();
    if (!isGit) return null;

    const remoteExists = await this.hasRemote(this.remote);
    if (remoteExists) {
      await this.fetchRemoteRef();
    }

    const remoteRef = this.getTrackingRef(this.remote, this.ref);
    return (
      (remoteExists ? await this.readSnapshotFromRef(remoteRef) : null) ||
      (await this.readSnapshotFromRef(this.ref))
    );
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

    const remoteExists = await this.hasRemote(this.remote);
    if (remoteExists) {
      // Attempt fetch from remote if configured (errors are captured in result)
      await this.fetchRemoteRef();
    }

    // Read remote ref or local ref
    const remoteRef = this.getTrackingRef(this.remote, this.ref);
    const snapshot =
      (remoteExists ? await this.readSnapshotFromRef(remoteRef) : null) ||
      (await this.readSnapshotFromRef(this.ref));

    if (!snapshot) {
      return {
        ok: true,
        updated: false,
        pulledCount: 0,
        localTotal: localStates.length,
      };
    }

    // Merge episodes if available
    if (snapshot.episodes && snapshot.episodes.length > 0) {
      const localEpisodes = await this.store.episodes();
      const mergedEpisodes = mergeEpisodes(localEpisodes, snapshot.episodes);
      if (mergedEpisodes.length !== localEpisodes.length) {
        await this.store.replaceLog(mergedEpisodes);
        await this.store.rebuild();
      }
    }

    const updatedStates = await this.store.list();
    return {
      ok: true,
      updated: true,
      pulledCount: snapshot.entities.length,
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

      const localCommit = await this.getRefCommit(this.ref);
      const remoteExists = await this.hasRemote(this.remote);
      const trackingRef = this.getTrackingRef(this.remote, this.ref);
      const remoteCommit = remoteExists ? await this.getRefCommit(trackingRef) : null;
      const parents: string[] = [];
      if (localCommit) parents.push(localCommit);
      if (remoteCommit && remoteCommit !== localCommit) parents.push(remoteCommit);

      const commit = await this.writeSnapshotToRef(
        snapshot,
        'Sage memory push',
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
            error: `Failed to push to remote ref '${this.remote}': ${pushRes.error ?? 'unknown error'}`,
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
        error: err instanceof Error ? err.message : String(err),
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
