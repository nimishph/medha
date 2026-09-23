/**
 * Unit tests for GitRefSyncAdapter against a real git repository (§7.2).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SAGE_REF, GitRefSyncAdapter } from '../index.ts';
import { createTestStore } from './test-store.ts';

describe('GitRefSyncAdapter', () => {
  let tempRepo: string;

  beforeEach(() => {
    tempRepo = mkdtempSync(join(tmpdir(), 'sage-git-sync-test-'));
    // Initialize a real git repository
    execFileSync('git', ['init'], { cwd: tempRepo });
    execFileSync('git', ['config', 'user.name', 'Sage Test'], { cwd: tempRepo });
    execFileSync('git', ['config', 'user.email', 'sage@test.local'], { cwd: tempRepo });
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
    expect(status.ref).toBe(DEFAULT_SAGE_REF);
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
});
