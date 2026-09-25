import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REJECT_CONTEXT, REJECT_RULE } from '@cntxt-labs/medha-core';
import { runStoreContractSuite, type StoreContractSetup } from '../contract-suite.ts';
import { SQLiteStore } from '../sqlite-store.ts';

const HOST_SIGNAL = {
  name: 'ADOPTED',
  value: 0.6,
  countsAsTrial: true,
  countsAsSuccess: true,
} as const;

const EXTRA_KIND = 'locator';

const now = 1_700_000_000_000;

const registries = {
  kinds: [EXTRA_KIND],
  signalSpecs: [HOST_SIGNAL],
  anchorKinds: ['week'],
};

const TMP = mkdtempSync(join(tmpdir(), 'medha-sqlite-'));
let counter = 0;
const tracked: SQLiteStore[] = [];
const freshDb = () => ({ path: join(TMP, `store-${counter++}.db`), registries });
const makeStore = (file: ConstructorParameters<typeof SQLiteStore>[0]): SQLiteStore => {
  const store = new SQLiteStore(file);
  tracked.push(store);
  return store;
};
// On Windows the file is only actually released after the async DB handles and the SQLite VFS
// settle, so the temp-dir cleanup retries the unlink for a short while instead of flaking.
function rmSyncWithRetry(path: string): void {
  const gate = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 9) throw error;
      Atomics.wait(gate, 0, 0, 100);
    }
  }
}

afterAll(async () => {
  await Promise.all(tracked.map((store) => store.close()));
  // bun:sqlite only releases the connection once its query/statement handles are collected; on
  // Windows the file stays locked until then, so force a GC before unlinking the temp directory.
  Bun.gc(true);
  rmSyncWithRetry(TMP);
});

const setup: StoreContractSetup = {
  extraKind: EXTRA_KIND,
  hostSignal: HOST_SIGNAL,
  async create() {
    return makeStore(freshDb());
  },
  async createCorrupt() {
    const file = freshDb();
    const store = makeStore(file);
    await store.open();
    await store.append({
      type: 'signal',
      key: { namespace: 'n', kind: 'rule', id: 'r1' },
      at: now,
      spec: REJECT_CONTEXT,
      ensure: true,
    });
    await store.append({
      type: 'signal',
      key: { namespace: 'n', kind: 'rule', id: 'r1' },
      at: now + 1,
      spec: REJECT_RULE,
      ensure: true,
    });
    await store.close();
    // Inject a row directly, bypassing append validation: a log that wobbles past seq 1.
    const db = new Database(file.path);
    db.run('INSERT INTO episodes (seq, json) VALUES (?, ?)', [
      2,
      JSON.stringify({
        type: 'signal',
        seq: 2,
        key: { namespace: 'n', kind: 'mystery', id: 'r1' },
        at: now + 2,
        spec: REJECT_CONTEXT,
        ensure: true,
      }),
    ]);
    db.close();
    return makeStore(file);
  },
};

runStoreContractSuite(setup);

describe('sqlite store — volume backend (spec §7.1)', () => {
  test('a closed and reopened database re-folds the log into the projection', async () => {
    const file = freshDb();
    const store = makeStore(file);
    await store.open();
    await store.append({
      type: 'signal',
      key: { namespace: 'n', kind: 'rule', id: 'r1' },
      at: now,
      spec: REJECT_CONTEXT,
      ensure: true,
    });
    await store.append({
      type: 'signal',
      key: { namespace: 'n', kind: 'rule', id: 'r1' },
      at: now + 1,
      spec: REJECT_RULE,
      ensure: true,
    });
    await store.close();

    const reopened = makeStore(file);
    expect((await reopened.open()).status).toBe('ok');
    const state = await reopened.get({ namespace: 'n', kind: 'rule', id: 'r1' });
    expect(state?.evidence.n).toBe(1);
    expect(state?.evidence.k).toBe(0);
    // The whole log is still the source of truth; afterSeq is exclusive.
    expect((await reopened.episodes()).map((e) => e.seq)).toEqual([0, 1]);
    expect((await reopened.episodes(0)).map((e) => e.seq)).toEqual([1]);
  });

  test('episodes tail reads are bounded by the limit, in seq order', async () => {
    const file = freshDb();
    const store = makeStore(file);
    await store.open();
    for (let i = 0; i < 10; i++) {
      await store.append({
        type: 'signal',
        key: { namespace: 'n', kind: 'rule', id: 'r1' },
        at: now + i,
        spec: REJECT_CONTEXT,
        ensure: true,
      });
    }
    expect((await store.episodes(4, 3)).map((e) => e.seq)).toEqual([5, 6, 7]);
  });

  test('reopen after close serves nothing until open (session invariant)', async () => {
    const file = freshDb();
    const store = makeStore(file);
    await store.open();
    await store.append({
      type: 'signal',
      key: { namespace: 'n', kind: 'rule', id: 'r1' },
      at: now,
      spec: REJECT_CONTEXT,
      ensure: true,
    });
    await store.close();
    await expect(makeStore(file).episodes()).rejects.toThrow();
  });
});
