/**
 * Unit tests for GitRefSyncAdapter against a real git repository (§7.2).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MEDHA_REF,
  DEFAULT_SAGE_REF,
  GitRefSyncAdapter,
  LEGACY_MEDHA_REF,
} from '../index.ts';
import { createTestStore } from './test-store.ts';

describe('GitRefSyncAdapter', () => {
  let tempRepo: string;

  beforeEach(() => {
    tempRepo = mkdtempSync(join(tmpdir(), 'medha-git-sync-test-'));
    // Initialize a real git repository
    execFileSync('git', ['init'], { cwd: tempRepo });
    execFileSync('git', ['config', 'user.name', 'Medha Test'], { cwd: tempRepo });
    execFileSync('git', ['config', 'user.email', 'medha@test.local'], { cwd: tempRepo });
    // Initial empty commit so HEAD exists
    execFileSync('git', ['commit', '--allow-empty', '-m', 'initial commit'], { cwd: tempRepo });
  });

  afterEach(() => {
    rmSync(tempRepo, { recursive: true, force: true });
  });

  it('detects a valid git repository', async () => {
    const store = createTestStore();
    await store.open();
    const adapter = new GitRefSyncAdapter({ store, rootDir: tempRepo });

    expect(await adapter.isGitRepo()).toBe(true);
  });

  it('reports uninitialized when git ref does not exist yet', async () => {
    const store = createTestStore();
    await store.open();
    const adapter = new GitRefSyncAdapter({ store, rootDir: tempRepo });

    const status = await adapter.status();
    expect(status.state).toBe('uninitialized');
    expect(status.ref).toBe(DEFAULT_MEDHA_REF);
  });

  it('pushes snapshot to git ref and verifies commit object', async () => {
    const store = createTestStore();
    await store.open();
    await store.append({
      key: { namespace: '', kind: 'rule', id: 'rule-git-1' },
      at: 1000,
      type: 'signal',
      spec: { name: 'APPLY', value: 1.0, countsAsTrial: true, countsAsSuccess: true },
      ensure: true,
    });

    const adapter = new GitRefSyncAdapter({ store, rootDir: tempRepo });

    const pushRes = await adapter.push({ now: 1000 });
    expect(pushRes.ok).toBe(true);
    expect(pushRes.commit).toBeDefined();

    // Verify ref commit exists
    const refCommit = await adapter.getRefCommit();
    expect(refCommit).toBe(pushRes.commit ?? null);

    // Read snapshot back from ref
    const snapshot = await adapter.readSnapshotFromRef();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.schemaVersion).toBe(1);
    expect(snapshot?.entities).toHaveLength(1);
    expect(snapshot?.entities[0]?.key.id).toBe('rule-git-1');

    // Status is now ahead of remote (no remote origin configured in local test repo)
    const status = await adapter.status();
    expect(status.state).toBe('ahead');
    expect(status.localHead).toBe(pushRes.commit);
  });

  it('pulls snapshot from git ref into another store', async () => {
    // 1. Store A writes to git ref
    const storeA = createTestStore();
    await storeA.open();
    await storeA.append({
      key: { namespace: '', kind: 'tool', id: 'tool-git-a' },
      at: 1000,
      type: 'signal',
      spec: { name: 'APPLY', value: 1.0, countsAsTrial: true, countsAsSuccess: true },
      ensure: true,
    });

    const adapterA = new GitRefSyncAdapter({ store: storeA, rootDir: tempRepo });
    await adapterA.push({ now: 1000 });

    // 2. Store B in the same repo pulls from git ref
    const storeB = createTestStore();
    await storeB.open();
    const adapterB = new GitRefSyncAdapter({ store: storeB, rootDir: tempRepo });

    const pullRes = await adapterB.pull({ now: 2000 });
    expect(pullRes.ok).toBe(true);

    const listB = await storeB.list();
    expect(listB).toHaveLength(1);
    expect(listB[0]?.key.id).toBe('tool-git-a');
  });
  it('pull() reports updated:false and pulledCount:0 when nothing changed', async () => {
    // 1. Store A writes to git ref
    const storeA = createTestStore();
    await storeA.open();
    await storeA.append({
      key: { namespace: '', kind: 'tool', id: 'tool-noop' },
      at: 1000,
      type: 'signal',
      spec: { name: 'APPLY', value: 1.0, countsAsTrial: true, countsAsSuccess: true },
      ensure: true,
    });

    const adapterA = new GitRefSyncAdapter({ store: storeA, rootDir: tempRepo });
    await adapterA.push({ now: 1000 });

    // 2. Store B pulls it in fully once...
    const storeB = createTestStore();
    await storeB.open();
    const adapterB = new GitRefSyncAdapter({ store: storeB, rootDir: tempRepo });
    const firstPull = await adapterB.pull({ now: 2000 });
    expect(firstPull.ok).toBe(true);
    expect(firstPull.updated).toBe(true);

    // ...then pulls again against the same, now-already-synced ref: no episode is
    // new, so nothing should be merged/rebuilt and this must be reported honestly.
    const secondPull = await adapterB.pull({ now: 3000 });
    expect(secondPull.ok).toBe(true);
    expect(secondPull.updated).toBe(false);
    expect(secondPull.pulledCount).toBe(0);
  });

  it('hard-deprecates DEFAULT_SAGE_REF and emits warning when used', async () => {
    const store = createTestStore();
    await store.open();
    const warnings: string[] = [];
    // biome-ignore lint/suspicious/noConsole: Intercept console.warn for deprecation test
    const originalWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);

    try {
      const adapter = new GitRefSyncAdapter({ store, rootDir: tempRepo, ref: DEFAULT_SAGE_REF });
      expect(adapter.ref).toBe(DEFAULT_SAGE_REF);
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0]).toContain('hard-deprecated');
    } finally {
      console.warn = originalWarn;
    }
  });

  it('dynamically computes tracking ref from custom and default refs', async () => {
    const store = createTestStore();
    await store.open();
    const adapter = new GitRefSyncAdapter({ store, rootDir: tempRepo });
    const res = await adapter.fetchRemoteRef('origin', DEFAULT_MEDHA_REF);
    expect(res.trackingRef).toBe('refs/remotes/origin/medha/memory');
  });

  it('pulls from a path remote without invalid refspec errors', async () => {
    // Create remote repo
    const remoteRepo = mkdtempSync(join(tmpdir(), 'medha-remote-repo-'));
    try {
      execFileSync('git', ['init'], { cwd: remoteRepo });
      execFileSync('git', ['config', 'user.name', 'Medha Remote'], { cwd: remoteRepo });
      execFileSync('git', ['config', 'user.email', 'remote@test.local'], { cwd: remoteRepo });
      execFileSync('git', ['commit', '--allow-empty', '-m', 'remote init'], { cwd: remoteRepo });

      // Populate remote store and push to its ref
      const remoteStore = createTestStore();
      await remoteStore.open();
      await remoteStore.append({
        key: { namespace: '', kind: 'rule', id: 'rule-from-path-remote' },
        at: 1000,
        type: 'signal',
        spec: { name: 'APPLY', value: 1.0, countsAsTrial: true, countsAsSuccess: true },
        ensure: true,
      });
      const remoteAdapter = new GitRefSyncAdapter({ store: remoteStore, rootDir: remoteRepo });
      await remoteAdapter.push({ now: 1000 });

      // In local repo, add the path remote
      execFileSync('git', ['remote', 'add', 'localpath', remoteRepo], { cwd: tempRepo });

      const localStore = createTestStore();
      await localStore.open();
      const localAdapter = new GitRefSyncAdapter({
        store: localStore,
        rootDir: tempRepo,
        remote: 'localpath',
      });

      const pullRes = await localAdapter.pull({ now: 2000 });
      expect(pullRes.ok).toBe(true);
      expect(pullRes.updated).toBe(true);

      const entities = await localStore.list();
      expect(entities).toHaveLength(1);
      expect(entities[0]?.key.id).toBe('rule-from-path-remote');
    } finally {
      rmSync(remoteRepo, { recursive: true, force: true });
    }
  });

  it('propagates push failure instead of claiming success on divergence', async () => {
    // Create a remote repo
    const remoteRepo = mkdtempSync(join(tmpdir(), 'medha-diverge-remote-'));
    try {
      execFileSync('git', ['init', '--bare'], { cwd: remoteRepo });
      execFileSync('git', ['remote', 'add', 'origin', remoteRepo], { cwd: tempRepo });

      // First push from local repo succeeds
      const store = createTestStore();
      await store.open();
      await store.append({
        key: { namespace: '', kind: 'rule', id: 'rule-init' },
        at: 1000,
        type: 'signal',
        spec: { name: 'APPLY', value: 1.0, countsAsTrial: true, countsAsSuccess: true },
        ensure: true,
      });
      const adapter = new GitRefSyncAdapter({ store, rootDir: tempRepo });
      const firstPush = await adapter.push({ now: 1000 });
      expect(firstPush.ok).toBe(true);

      // Now create a divergent commit directly on the bare remote ref
      const secondRepo = mkdtempSync(join(tmpdir(), 'medha-diverge-second-'));
      try {
        execFileSync('git', ['clone', remoteRepo, secondRepo], { cwd: tmpdir() });
        execFileSync('git', ['config', 'user.name', 'Medha Second'], { cwd: secondRepo });
        execFileSync('git', ['config', 'user.email', 'second@test.local'], { cwd: secondRepo });

        const store2 = createTestStore();
        await store2.open();
        await store2.append({
          key: { namespace: '', kind: 'rule', id: 'rule-divergent' },
          at: 2000,
          type: 'signal',
          spec: { name: 'APPLY', value: 1.0, countsAsTrial: true, countsAsSuccess: true },
          ensure: true,
        });
        const adapter2 = new GitRefSyncAdapter({ store: store2, rootDir: secondRepo });
        await adapter2.pull({ now: 2000 });
        const secondPush = await adapter2.push({ now: 2000 });
        expect(secondPush.ok).toBe(true);

        // Now local repo attempts to push without pulling first (will diverge)
        await store.append({
          key: { namespace: '', kind: 'rule', id: 'rule-local-only' },
          at: 3000,
          type: 'signal',
          spec: { name: 'APPLY', value: 1.0, countsAsTrial: true, countsAsSuccess: true },
          ensure: true,
        });
        // Try push - must fail and report error rather than silent loss
        const failedPush = await adapter.push({ now: 3000 });
        expect(failedPush.ok).toBe(false);
        expect(failedPush.error).toBeDefined();
      } finally {
        rmSync(secondRepo, { recursive: true, force: true });
      }
    } finally {
      rmSync(remoteRepo, { recursive: true, force: true });
    }
  }, 20000);

  // GitHub #7: the scenarios below each used to report `ok` while doing nothing, or hid git's reason.
  describe('remotes given as a path or URL, and failure reporting', () => {
    let remoteRepo: string;

    /** A bare repo holding one pushed entity on `ref`, pushed through a configured remote. */
    async function seedBareRemote(id: string, ref?: string): Promise<void> {
      const seeder = mkdtempSync(join(tmpdir(), 'medha-seeder-'));
      try {
        execFileSync('git', ['init'], { cwd: seeder });
        // CI runners have no global git identity, and the push writes a commit.
        execFileSync('git', ['config', 'user.name', 'Medha Seeder'], { cwd: seeder });
        execFileSync('git', ['config', 'user.email', 'seeder@test.local'], { cwd: seeder });
        execFileSync('git', ['remote', 'add', 'origin', remoteRepo], { cwd: seeder });
        const store = createTestStore();
        await store.open();
        await store.append({
          key: { namespace: '', kind: 'rule', id },
          at: 1000,
          type: 'signal',
          spec: { name: 'APPLY', value: 1.0, countsAsTrial: true, countsAsSuccess: true },
          ensure: true,
        });
        const adapter = new GitRefSyncAdapter({ store, rootDir: seeder, ref });
        expect((await adapter.push({ now: 1000 })).ok).toBe(true);
      } finally {
        rmSync(seeder, { recursive: true, force: true });
      }
    }

    beforeEach(() => {
      remoteRepo = mkdtempSync(join(tmpdir(), 'medha-bare-remote-'));
      execFileSync('git', ['init', '--bare'], { cwd: remoteRepo });
    });

    afterEach(() => {
      rmSync(remoteRepo, { recursive: true, force: true });
    });

    it('pulls from an unconfigured path remote', async () => {
      await seedBareRemote('from-path');
      const store = createTestStore();
      await store.open();
      const adapter = new GitRefSyncAdapter({ store, rootDir: tempRepo, remote: remoteRepo });

      const pulled = await adapter.pull({ now: 2000 });
      expect(pulled).toMatchObject({ ok: true, updated: true, pulledCount: 1 });
      expect((await store.list())[0]?.key.id).toBe('from-path');
    }, 20000);

    it('pushes to an unconfigured path remote', async () => {
      const store = createTestStore();
      await store.open();
      await store.append({
        key: { namespace: '', kind: 'rule', id: 'pushed-by-path' },
        at: 1000,
        type: 'signal',
        spec: { name: 'APPLY', value: 1.0, countsAsTrial: true, countsAsSuccess: true },
        ensure: true,
      });
      const adapter = new GitRefSyncAdapter({ store, rootDir: tempRepo, remote: remoteRepo });
      expect((await adapter.push({ now: 1000 })).ok).toBe(true);
      const onRemote = execFileSync('git', ['rev-parse', DEFAULT_MEDHA_REF], { cwd: remoteRepo })
        .toString()
        .trim();
      expect(onRemote).toMatch(/^[0-9a-f]{40}$/);
    }, 20000);

    it('fails, naming the problem, for a remote name that is not configured', async () => {
      const store = createTestStore();
      await store.open();
      const adapter = new GitRefSyncAdapter({ store, rootDir: tempRepo, remote: 'team' });

      const pulled = await adapter.pull({ now: 2000 });
      expect(pulled.ok).toBe(false);
      expect(pulled.error).toContain('git remote add team <url>');
      const pushed = await adapter.push({ now: 2000 });
      expect(pushed.ok).toBe(false);
      expect(pushed.error).toContain('git remote add team <url>');
    });

    it('fails for a path remote that is not a repository instead of reporting ok', async () => {
      const store = createTestStore();
      await store.open();
      const missing = join(remoteRepo, 'does-not-exist.git');
      const adapter = new GitRefSyncAdapter({ store, rootDir: tempRepo, remote: missing });

      const pulled = await adapter.pull({ now: 2000 });
      expect(pulled.ok).toBe(false);
      expect(pulled.error).toContain('git fetch from');
    }, 20000);

    it('a remote that lacks the ref yet is an empty pull, not a failure', async () => {
      const store = createTestStore();
      await store.open();
      const adapter = new GitRefSyncAdapter({ store, rootDir: tempRepo, remote: remoteRepo });
      expect(await adapter.pull({ now: 2000 })).toMatchObject({ ok: true, pulledCount: 0 });
    }, 20000);

    it("a push blocked by a hook reports git's own output", async () => {
      execFileSync('git', ['remote', 'add', 'origin', remoteRepo], { cwd: tempRepo });
      const hook = join(tempRepo, '.git', 'hooks', 'pre-push');
      writeFileSync(hook, '#!/bin/sh\necho "BLOCKED by policy hook" >&2\nexit 1\n');
      chmodSync(hook, 0o755);

      const store = createTestStore();
      await store.open();
      await store.append({
        key: { namespace: '', kind: 'rule', id: 'blocked' },
        at: 1000,
        type: 'signal',
        spec: { name: 'APPLY', value: 1.0, countsAsTrial: true, countsAsSuccess: true },
        ensure: true,
      });
      const adapter = new GitRefSyncAdapter({ store, rootDir: tempRepo });
      const pushed = await adapter.push({ now: 1000 });
      expect(pushed.ok).toBe(false);
      expect(pushed.error).toContain("git push to 'origin' failed");
      expect(pushed.error).toContain('BLOCKED by policy hook');
      expect(pushed.error).not.toContain('Unexpected failure');
    }, 20000);

    it('reads evidence an older medha pushed to the legacy ref, and writes the new one', async () => {
      await seedBareRemote('from-legacy', LEGACY_MEDHA_REF);
      execFileSync('git', ['remote', 'add', 'origin', remoteRepo], { cwd: tempRepo });
      const store = createTestStore();
      await store.open();
      const adapter = new GitRefSyncAdapter({ store, rootDir: tempRepo });
      expect(adapter.ref).toBe('refs/medha/memory');

      const status = await adapter.status();
      expect(status.ref).toBe(LEGACY_MEDHA_REF);
      expect(status.state).toBe('behind');

      expect(await adapter.pull({ now: 2000 })).toMatchObject({ ok: true, pulledCount: 1 });
      expect((await store.list())[0]?.key.id).toBe('from-legacy');

      expect((await adapter.push({ now: 3000 })).ok).toBe(true);
      const heads = execFileSync('git', ['for-each-ref', '--format=%(refname)'], {
        cwd: remoteRepo,
      }).toString();
      expect(heads).toContain(DEFAULT_MEDHA_REF);
      expect((await adapter.status()).ref).toBe(DEFAULT_MEDHA_REF);
    }, 20000);

    it('an explicit ref does not read the legacy ref', async () => {
      await seedBareRemote('legacy-only', LEGACY_MEDHA_REF);
      const store = createTestStore();
      await store.open();
      const adapter = new GitRefSyncAdapter({
        store,
        rootDir: tempRepo,
        remote: remoteRepo,
        ref: 'refs/team/memory',
      });
      expect(await adapter.pull({ now: 2000 })).toMatchObject({ ok: true, pulledCount: 0 });
    }, 20000);
  });
});
