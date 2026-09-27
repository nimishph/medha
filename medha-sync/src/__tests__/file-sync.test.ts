/**
 * Unit tests for FileSyncAdapter (§7.2).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSyncAdapter } from '../index.ts';
import { createTestStore } from './test-store.ts';

describe('FileSyncAdapter', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'medha-file-sync-test-'));
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

  it('pull() reports honestly and leaves the store untouched when a snapshot has no episodes to reconcile', async () => {
    const store = createTestStore();
    await store.open();

    const filePath = join(tempDir, 'sync.json');
    // A snapshot whose entities disagree with local state but carries no episode
    // log: pull() has no StorePort path to write entity state directly, so it
    // must not claim it merged/pulled anything.
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        asOf: 1000,
        registries: { kinds: [], signalSpecs: [], anchorKinds: [] },
        entities: [
          {
            key: { namespace: '', kind: 'rule', id: 'phantom' },
            status: 'active',
            trustScore: 0.9,
            components: { wilson: 0.9, guard: 1, recency: 1, durability: 1, ceiling: 1 },
            evidence: { successes: 5, totalTrials: 5, lowerBound: 0.5 },
            temporal: { emaWeight: 0.9, driftDelta: 0, isDrifting: false },
            clearsThreshold: { trusted: true, active: true },
            asOf: 1000,
          },
        ],
      }),
      'utf8',
    );

    const adapter = new FileSyncAdapter({ store, filePath });
    const pullRes = await adapter.pull();

    expect(pullRes.ok).toBe(true);
    expect(pullRes.updated).toBe(false);
    expect(pullRes.pulledCount).toBe(0);
    expect(pullRes.localTotal).toBe(0);

    const list = await store.list();
    expect(list).toEqual([]);
  });

  it('push() refuses to overwrite a sync file that changed since the last pull', async () => {
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

    // A publishes the initial file.
    expect((await adapterA.push({ now: 1000 })).ok).toBe(true);

    // B reads it (establishing its expected-previous-content baseline)...
    expect((await adapterB.pull({ now: 1500 })).ok).toBe(true);

    // ...then A writes again, changing the file B last observed.
    expect((await adapterA.push({ now: 2000 })).ok).toBe(true);

    // B pushes without pulling A's latest write: must fail loudly, not silently
    // overwrite A's update.
    const staleB = await adapterB.push({ now: 2500 });
    expect(staleB.ok).toBe(false);
    expect(staleB.error).toMatch(/diverged/i);

    // A's write must still be intact on disk.
    const finalStatus = await adapterA.status();
    expect(finalStatus.remoteCount).toBe(1);
  });
});
