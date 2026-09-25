import { describe, expect, test } from 'bun:test';
import {
  DAY_MS,
  type EntityKey,
  entityKeyString,
  InvalidArgumentError,
} from '@cntxt-labs/medha-core';
import { MemoryStore } from '@cntxt-labs/medha-store';
import { Medha } from '../engine.ts';
import {
  type PreflightReport,
  SNAPSHOT_FORMAT,
  type SweepChange,
  type SweepReport,
  type SweepSkipped,
  statesEquivalent,
} from '../maintenance.ts';

/**
 * Maintenance plane (§6.4 session-start sweep, §8 lifecycle rules, compaction, preflight,
 * backup/restore) acceptance:
 * - every §8 rule and its exceptions,
 * - `open()` twice inside the sweep interval is a no-op,
 * - compaction folds the strict prefix and reports the exact folded range,
 * - preflight reports (never throws) and backup/restore round-trips.
 */

const NOW = 1_700_000_000_000;
const DAY = DAY_MS;
const HOST_KIND = 'host';

const key = (id: string, kind = 'rule'): EntityKey => ({ namespace: 'ns', kind, id });

function makeEngine() {
  const store = new MemoryStore({
    registries: { kinds: [HOST_KIND], signalSpecs: [], anchorKinds: ['week'] },
  });
  return { store, medha: new Medha({ store }) };
}

function corruptEngine() {
  const store = new MemoryStore({
    registries: { kinds: [HOST_KIND], signalSpecs: [], anchorKinds: ['week'] },
    initialEpisodes: [
      {
        type: 'signal',
        seq: 0,
        key: { namespace: '', kind: 'unknown', id: 'x' },
        at: 1_000,
        ensure: true,
        spec: { name: 'APPLY', value: 1, countsAsTrial: true, countsAsSuccess: true },
      },
    ],
  });
  return { store, medha: new Medha({ store }) };
}

async function applyN(
  medha: Medha,
  k: EntityKey,
  n: number,
  base: number,
  offsetMs = 1_000,
): Promise<void> {
  for (let i = 0; i < n; i++) {
    await medha.record(k, 'APPLY', { now: base + i * offsetMs }, { ensure: true });
  }
}

async function seedDrifting(medha: Medha, k: EntityKey, base: number): Promise<void> {
  await applyN(medha, k, 10, base);
  for (let i = 0; i < 10; i++) {
    await medha.record(k, 'REJECT_RULE', { now: base + 10_000 + i * 1_000 });
  }
}

function isSkipped(report: SweepReport | SweepSkipped): report is SweepSkipped {
  return 'skipped' in report;
}

function isSwept(report: SweepReport | SweepSkipped): report is SweepReport {
  return 'asOf' in report && 'changes' in report;
}

describe('maintenance plane — sweep (§8)', () => {
  test('drift (§8: delta >= 0.40, n >= 3) is quarantined into a durable override', async () => {
    const { medha } = makeEngine();
    const k = key('d');
    await seedDrifting(medha, k, NOW);

    const report = await medha.open({ now: NOW + 200 });
    expect(isSwept(report)).toBe(true);
    if (!isSwept(report)) return;
    expect(report.quarantineCount).toBe(1);
    const change = report.changes.find((c: SweepChange) => c.action === 'quarantine');
    expect(change?.key).toEqual(k);
    expect(change?.action).toBe('quarantine');
    expect(change?.at).toBe(NOW + 200);
    expect(change?.reason).toContain('drift');

    // The override is durable in state, not just in the log.
    const hint = (await medha.show(k, { now: NOW + 200 })).hint;
    expect(hint.status).toBe('quarantined');
  });

  test('drift exemption: an already-overridden entity is not double-stamped', async () => {
    const { medha } = makeEngine();
    const k = key('d3');
    await seedDrifting(medha, k, NOW);
    await medha.override(k, 'quarantine', { now: NOW + 10 }, 'manual quarantine');

    const report = await medha.open({ now: NOW + 200 });
    expect(isSwept(report) && report.quarantineCount).toBe(0);
  });

  test('stale (§8: no new evidence, recency at the floor) is retired', async () => {
    const { medha, store } = makeEngine();
    const k = key('s');
    await applyN(medha, k, 12, NOW - 200 * DAY);

    const report = await medha.open({ now: NOW });
    expect(isSwept(report)).toBe(true);
    if (!isSwept(report)) return;
    expect(report.retireCount).toBe(1);
    const change = report.changes.find((c: SweepChange) => c.action === 'retire');
    expect(change?.key).toEqual(k);
    expect(change?.action).toBe('retire');
    expect(change?.at).toBe(NOW);
    expect(change?.reason).toContain('stale');

    const state = (await store.list()).find((s) => entityKeyString(s.key) === entityKeyString(k));
    expect(state?.override).toBe('retired');
    expect(state?.retiredAt).toBe(NOW);
  });

  test('stale exemption: a zero-evidence probe (n === 0) is never pruned', async () => {
    const { medha } = makeEngine();
    const k = key('z');
    await medha.record(k, 'SKIP', { now: NOW - 200 * DAY }, { ensure: true });

    const report = await medha.open({ now: NOW });
    expect(isSwept(report) && report.changes.length).toBe(0);
    expect((await medha.show(k, { now: NOW })).hint.status).toBe('probation');
  });

  test('stale exemption: an entity restored since its last evidence is never pruned', async () => {
    const { medha, store } = makeEngine();
    const k = key('r');
    await applyN(medha, k, 12, NOW - 200 * DAY);
    await medha.override(k, 'retire', { now: NOW - 110 * DAY }, 'manual retire');
    await medha.override(k, 'restore', { now: NOW - 5 * DAY }, 'manual restore');

    const report = await medha.open({ now: NOW });
    expect(isSwept(report) && report.changes.length).toBe(0);
    const state = (await store.list()).find((s) => entityKeyString(s.key) === entityKeyString(k));
    expect(state?.override).toBeNull();
    expect(state?.restoredAt).toBe(NOW - 5 * DAY);
  });

  test('stale exemption: recent evidence keeps the entity active', async () => {
    const { medha } = makeEngine();
    const k = key('recent');
    await applyN(medha, k, 12, NOW - 200 * DAY);
    await applyN(medha, k, 1, NOW - DAY);

    const report = await medha.open({ now: NOW });
    expect(isSwept(report) && report.changes.length).toBe(0);
    expect((await medha.show(k, { now: NOW })).hint.status).toBe('active');
  });

  test('retention (§8: retired past the window) archives then purges', async () => {
    const { medha } = makeEngine();
    const k = key('gone');
    await applyN(medha, k, 3, NOW - 110 * DAY);
    await medha.override(k, 'retire', { now: NOW - 100 * DAY }, 'manual retire');

    const report = await medha.open({ now: NOW });
    expect(isSwept(report)).toBe(true);
    if (!isSwept(report)) return;
    expect(report.archiveCount).toBe(1);
    expect(report.purgeCount).toBe(1);
    const actions = report.changes.map((c: SweepChange) => c.action);
    expect(actions).toEqual(['archive', 'purge']);

    // Purging actually removes the entity from the index.
    const hint = await medha.show(k, { now: NOW });
    expect(hint.known).toBe(false);
  });

  test('every change lands as a sweep episode in the log', async () => {
    const { medha, store } = makeEngine();
    const k = key('d2');
    await seedDrifting(medha, k, NOW);

    await medha.open({ now: NOW + 200 });
    const log = await store.episodes();
    const sweeps = log.filter((e) => e.type === 'sweep' && e.action === 'quarantine');
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]?.key).toEqual(k);
    expect(sweeps[0]?.at).toBe(NOW + 200);
  });

  test('open() twice inside the interval is a no-op that reports the next due time', async () => {
    const { medha, store } = makeEngine();
    await applyN(medha, key('a'), 3, NOW - 200 * DAY);

    const first = await medha.open({ now: NOW });
    expect(isSwept(first)).toBe(true);
    const logAfterFirst = await store.episodes();

    const second = await medha.open({ now: NOW + 1000 }, { sweepEvery: 8 * 3_600_000 });
    expect(isSkipped(second) && second.skipped).toBe('within-interval');
    if (!isSkipped(second) || second.skipped !== 'within-interval') return;
    expect(second.lastSweep).toBe(NOW);
    expect(second.dueAt).toBe(NOW + 8 * 3_600_000);
    expect(await store.episodes()).toEqual(logAfterFirst);
  });

  test('open() on a corrupt store skips with the exact location', async () => {
    const { medha } = corruptEngine();
    const report = await medha.open({ now: NOW });
    expect(isSkipped(report) && report.skipped).toBe('store-corrupt');
    if (!isSkipped(report) || report.skipped !== 'store-corrupt') return;
    expect(report.location.atSeq).toBe(0);
  });

  test('two identical engines produce identical sweep reports (determinism)', async () => {
    async function build(): Promise<string> {
      const { medha } = makeEngine();
      const k = key('det');
      await applyN(medha, k, 5, NOW - 300 * DAY);
      await applyN(medha, k, 3, NOW - 5 * DAY);
      const report = await medha.open({ now: NOW });
      return JSON.stringify(report);
    }
    expect(await build()).toEqual(await build());
  });

  test('explicit sweep interval is respected and fractional options are rejected', async () => {
    const { medha } = makeEngine();
    await applyN(medha, key('x'), 1, NOW - 1 * DAY);
    await medha.open({ now: NOW }, { sweepEvery: 60_000 });

    const second = await medha.open({ now: NOW + 30_000 }, { sweepEvery: 60_000 });
    expect(isSkipped(second) && second.skipped).toBe('within-interval');

    await expect(medha.open({ now: NOW + 90_000 }, { sweepEvery: -1 })).rejects.toThrow(
      InvalidArgumentError,
    );
    await expect(medha.open({ now: NOW + 90_000 }, { retentionDays: 0 })).rejects.toThrow(
      InvalidArgumentError,
    );
  });
});

describe('maintenance plane — compaction (§6.4, §8 folding)', () => {
  test('compact folds the strict prefix and names the exact folded range', async () => {
    const { store, medha } = makeEngine();
    const k = key('c');
    await applyN(medha, k, 3, NOW - 200 * DAY);
    await applyN(medha, k, 1, NOW - DAY);

    const before = await store.list();
    const beforeLog = await store.episodes();
    expect(beforeLog).toHaveLength(4);

    const report = await medha.compact({ now: NOW }, { olderThan: 90 });
    expect(report.compacted).not.toBeNull();
    if (report.compacted === null) return;
    expect(report.compacted).toEqual({ from: 0, to: 2 });

    const afterLog = await store.episodes();
    expect(afterLog).toHaveLength(2);
    expect(afterLog[0]?.type).toBe('baseline');
    expect(afterLog[1]?.type).toBe('signal');
    expect(afterLog[1]?.at).toBe(NOW - DAY);

    // Folding is lossless: the compacted log reproduces the pre-compaction index.
    expect(statesEquivalent(before, await store.list())).toBe(true);
  });

  test('compact with nothing old enough is a harmless no-op', async () => {
    const { store, medha } = makeEngine();
    const k = key('fresh');
    await applyN(medha, k, 1, NOW - 1 * DAY);

    const report = await medha.compact({ now: NOW }, { olderThan: 90 });
    expect(report.compacted).toBeNull();
    expect(report.remainingEpisodes).toBe(1);
    expect(await store.episodes()).toHaveLength(1);
  });

  test('compaction keeps the retiredAt clock so retention still acts afterwards', async () => {
    const { medha } = makeEngine();
    const k = key('clock');
    await applyN(medha, k, 3, NOW - 110 * DAY);
    await medha.override(k, 'retire', { now: NOW - 100 * DAY }, 'manual retire');

    // The retire episode (100d back) is older than the 90d fold window, so it folds into the
    // baseline; retiredAt must survive the fold or retention would leak the entity forever.
    const report = await medha.open({ now: NOW });
    expect(isSwept(report)).toBe(true);
    if (!isSwept(report)) return;
    expect(report.compact.folded).not.toBeNull();
    expect(report.purgeCount).toBe(1);
    expect((await medha.show(k, { now: NOW })).known).toBe(false);
  });
});

describe('maintenance plane — preflight (§9 maintain preflight)', () => {
  test('reports health on a healthy store without ever sweeping', async () => {
    const { medha, store } = makeEngine();
    await applyN(medha, key('a'), 3, NOW - 1 * DAY);

    const report = await medha.preflight({ now: NOW });
    expect(report.status).toBe('ok');
    expect(report.integrity).toBe('ok');
    expect(report.episodeCount).toBe(3);
    expect(report.entityCount).toBe(1);
    expect(report.lastSweep).toBeNull();
    expect(report.asOf).toBe(NOW);
    expect(report.registries.kinds).toBeGreaterThan(0);
    expect(await store.getMeta('sweep:lastRun')).toBeUndefined();
  });

  test('reports the last sweep timestamp after an open(), still without sweeping', async () => {
    const { medha } = makeEngine();
    await applyN(medha, key('b'), 1, NOW - 1 * DAY);
    await medha.open({ now: NOW });

    const report = await medha.preflight({ now: NOW + 1 });
    expect((report as PreflightReport).lastSweep).toBe(NOW);
  });

  test('reports corruption instead of throwing', async () => {
    const { medha } = corruptEngine();
    const report = await medha.preflight({ now: NOW });
    expect(report.status).toBe('corrupt');
    expect(report.location?.atSeq).toBe(0);
    expect(report.episodeCount).toBe(0);
    expect(report.entityCount).toBe(0);
  });
});

describe('maintenance plane — backup / restore (§6.4, §9)', () => {
  test('backup snapshot round-trips through restore', async () => {
    const { store: fromStore, medha: from } = makeEngine();
    const k = key('bt');
    await applyN(from, k, 3, NOW - 200 * DAY);
    await applyN(from, k, 1, NOW - 1 * DAY);
    await from.open({ now: NOW });

    const log = await fromStore.episodes();
    const { snapshot } = await from.backup({ now: NOW });
    expect(snapshot.format).toBe(SNAPSHOT_FORMAT);
    expect(snapshot.exportedAt).toBe(NOW);
    expect(snapshot.episodes).toHaveLength(log.length);
    expect(snapshot.meta).toHaveProperty('sweep:lastRun');

    const fromIndex = await fromStore.list();
    const { store: toStore, medha: to } = makeEngine();
    const { restored } = await to.restore(snapshot);
    expect(restored.from).toBe(0);

    expect(await toStore.episodes()).toHaveLength(snapshot.episodes.length);
    expect(await toStore.getMeta('sweep:lastRun')).toBe(String(NOW));
    expect(statesEquivalent(fromIndex, await toStore.list())).toBe(true);
  });

  test('two identical backups are byte-identical (deterministic snapshot)', async () => {
    async function snapshot(): Promise<string> {
      const { medha } = makeEngine();
      await applyN(medha, key('d0'), 3, NOW - 5 * DAY);
      return JSON.stringify((await medha.backup({ now: NOW })).snapshot);
    }
    expect(await snapshot()).toEqual(await snapshot());
  });

  test('restore rejects a snapshot from another world', async () => {
    const { medha } = makeEngine();
    const { snapshot } = await medha.backup({ now: NOW });
    await expect(medha.restore({ ...snapshot, format: 'other/v9' } as never)).rejects.toThrow(
      InvalidArgumentError,
    );
  });
});
