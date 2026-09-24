/**
 * Unit tests for FileSyncAdapter (§7.2).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSyncAdapter } from '../index.ts';
import { createTestStore } from './test-store.ts';

describe('FileSyncAdapter', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sage-file-sync-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports uninitialized when sync file does not exist', async () => {
    const store = createTestStore();
    await store.open();

    const filePath = join(tempDir, 'sync.json');
    const adapter = new FileSyncAdapter({ store, filePath });

    const status = await adapter.status();
    expect(status.state).toBe('uninitialized');
    expect(status.localCount).toBe(0);
  });

  it('pushes local store snapshot to file and reports synced', async () => {
    const store = createTestStore();
    await store.open();

    await store.append({
      key: { namespace: '', kind: 'rule', id: 'rule-1' },
      at: 1000,
      type: 'signal',
      spec: { name: 'APPLY', value: 1.0, countsAsTrial: true, countsAsSuccess: true },
      ensure: true,
    });

    const filePath = join(tempDir, 'sync.json');
    const adapter = new FileSyncAdapter({ store, filePath });

    const pushRes = await adapter.push({ now: 1000 });
    expect(pushRes.ok).toBe(true);
    expect(pushRes.pushedCount).toBe(1);

    const status = await adapter.status();
    expect(status.state).toBe('synced');
    expect(status.localCount).toBe(1);
    expect(status.remoteCount).toBe(1);
  });

  it('reconciles two stores through a shared file and converges', async () => {
    const storeA = createTestStore();
    await storeA.open();
    await storeA.append({
      key: { namespace: '', kind: 'rule', id: 'rule-a' },
      at: 1000,
      type: 'signal',
      spec: { name: 'APPLY', value: 1.0, countsAsTrial: true, countsAsSuccess: true },
      ensure: true,
    });

    const storeB = createTestStore();
    await storeB.open();
    await storeB.append({
      key: { namespace: '', kind: 'rule', id: 'rule-b' },
      at: 2000,
      type: 'signal',
      spec: { name: 'APPLY', value: 1.0, countsAsTrial: true, countsAsSuccess: true },
      ensure: true,
    });

    const filePath = join(tempDir, 'shared-sync.json');
    const adapterA = new FileSyncAdapter({ store: storeA, filePath });
    const adapterB = new FileSyncAdapter({ store: storeB, filePath });

    // A pushes to shared file
    await adapterA.push({ now: 1000 });

    // B reconciles: pulls A, merges, pushes merged
    const recB = await adapterB.reconcile({ now: 2000 });
    expect(recB.ok).toBe(true);

    // A reconciles: pulls merged
    const recA = await adapterA.reconcile({ now: 3000 });
    expect(recA.ok).toBe(true);

    // Both stores now have both entities!
    const listA = await storeA.list();
    const listB = await storeB.list();

    expect(listA.map((e) => e.key.id).sort()).toEqual(['rule-a', 'rule-b']);
    expect(listB.map((e) => e.key.id).sort()).toEqual(['rule-a', 'rule-b']);
  });
});
