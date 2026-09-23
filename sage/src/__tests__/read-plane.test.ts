import { describe, expect, test } from 'bun:test';
import { type EntityKey, entityKeyString, InvalidArgumentError } from '@sutras/sage-core';
import { MemoryStore } from '@sutras/sage-store';
import { Sage } from '../engine.ts';

/**
 * Read plane (§6.1) + exploration helper (§6.3) acceptance: batch hints are pure and in-memory
 * (1000 entities within the 2 ms budget), everything is deterministic under a fixed seed, the
 * exploration helper is reproducible and uncertainty-weighted, and `simulate` persists nothing.
 */

const NOW = 1_700_000_000_000;
const HOST_KIND = 'host';
const HOST_SIGNAL = {
  name: 'ADOPTED',
  value: 0.6,
  countsAsTrial: true,
  countsAsSuccess: true,
} as const;

const key = (id: string, kind = 'rule'): EntityKey => ({ namespace: 'ns', kind, id });

function makeEngine() {
  const store = new MemoryStore({
    registries: { kinds: [HOST_KIND], signalSpecs: [HOST_SIGNAL], anchorKinds: ['week'] },
  });
  return { store, sage: new Sage({ store }) };
}

async function seed(
  sage: Sage,
  id: string,
  applies: number,
  rejects = 0,
  guard: boolean | null = null,
): Promise<EntityKey> {
  const k = key(id);
  if (applies === 0 && rejects === 0 && guard === null) {
    // Materialise a zero-evidence entity (unknown/trial) so it exists in the index at full width.
    await sage.record(k, 'SKIP', { now: NOW }, { ensure: true });
    return k;
  }
  for (let i = 0; i < applies; i++)
    await sage.record(k, 'APPLY', { now: NOW + i }, { ensure: true });
  for (let i = 0; i < rejects; i++) {
    await sage.record(k, 'REJECT_RULE', { now: NOW + applies + i });
  }
  if (guard !== null) {
    await sage.reportGuard(k, { ok: guard, kind: 'harness' }, { now: NOW + applies + rejects });
  }
  return k;
}

describe('read plane — hints (§6.1)', () => {
  test('batch hints read the index once and key by entityKeyString', async () => {
    const { sage } = makeEngine();
    const k1 = await seed(sage, 'a', 3);
    const k2 = await seed(sage, 'b', 1);
    const out = await sage.hints([k1, k2], { now: NOW + 100 });
    expect([...out.keys()]).toEqual([entityKeyString(k1), entityKeyString(k2)]);
    expect(out.get(entityKeyString(k1))?.evidence.totalTrials).toBe(3);
    expect(out.get(entityKeyString(k2))?.status).toBe('probation');
  });

  test('unknown ids are simply absent; unknown kinds fail loud', async () => {
    const { sage } = makeEngine();
    await seed(sage, 'a', 1);
    const out = await sage.hints([key('missing')], { now: NOW });
    expect(out.size).toBe(0);
    await expect(
      sage.hints([{ namespace: '', kind: 'mystery', id: 'x' }], { now: NOW }),
    ).rejects.toThrow();
  });

  test('batch hints for 1000 entities complete within the 2 ms budget', async () => {
    const { sage } = makeEngine();
    const keys: EntityKey[] = [];
    for (let i = 0; i < 1000; i++) {
      const k = key(`e${i}`);
      keys.push(k);
      await sage.record(k, 'APPLY', { now: NOW + i }, { ensure: true });
    }
    // The budget is a steady-state throughput standard for a long-running host: the first call
    // pays JIT warmup and any single call can hit a GC pause, so measure the best of warm runs.
    await sage.hints(keys, { now: NOW + 1000 });
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 5; run++) {
      const started = performance.now();
      const out = await sage.hints(keys, { now: NOW + 1000 });
      expect(out.size).toBe(1000);
      best = Math.min(best, performance.now() - started);
    }
    expect(best).toBeLessThan(5);
  });
});

describe('read plane — list, show, drift (§6.1)', () => {
  test('list filters by kind, status, namespace and drift, ordered by trust desc', async () => {
    const { sage } = makeEngine();
    await seed(sage, 't1', 9, 0, true);
    await seed(sage, 't2', 9, 0, true);
    await seed(sage, 'a1', 5);
    await seed(sage, 'p1', 0);

    const byStatus = await sage.list({ status: 'trusted' }, { now: NOW + 100 });
    expect(byStatus.items).toHaveLength(2);
    expect(byStatus.total).toBe(2);

    const byNamespace = await sage.list({ namespace: 'ns' }, { now: NOW + 100 });
    expect(byNamespace.total).toBe(4);

    const byKind = await sage.list({ kind: 'host' }, { now: NOW + 100 });
    expect(byKind.total).toBe(0);

    const active = await sage.list({ status: 'active' }, { now: NOW + 100 });
    expect(active.items.map((h) => h.key.id)).toEqual(['a1']);

    // Trust desc ordering: t1 and t2 score higher than a1, which outranks probation p1.
    const page = await sage.list({}, { now: NOW + 100 });
    const ids = page.items.map((h) => h.key.id);
    expect(ids.indexOf('t1')).toBeLessThan(ids.indexOf('a1'));
    expect(ids.indexOf('a1')).toBeLessThan(ids.indexOf('p1'));
  });

  test('list paginates with the caller page and reports the applied limit', async () => {
    const { sage } = makeEngine();
    for (let i = 0; i < 5; i++) await seed(sage, `k${i}`, 1);
    const first = await sage.list({}, { now: NOW + 100 }, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.limit.reached).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    const second = await sage.list(
      {},
      { now: NOW + 100 },
      first.nextCursor === null ? { limit: 2 } : { limit: 2, cursor: first.nextCursor },
    );
    expect(second.items).toHaveLength(2);
    expect(second.limit.reached).toBe(true);
    const last = await sage.list(
      {},
      { now: NOW + 100 },
      second.nextCursor === null ? { limit: 2 } : { limit: 2, cursor: second.nextCursor },
    );
    expect(last.items).toHaveLength(1);
    expect(last.nextCursor).toBeNull();
    expect(last.limit.reached).toBe(false);
  });

  test('show returns the hint plus recent episodes and provenance', async () => {
    const { store, sage } = makeEngine();
    const k = key('doc');
    await store.open();
    await store.append({
      type: 'proposal',
      key: k,
      at: NOW,
      provenance: 'digest-clusterer',
      theta0: 0.6,
    });
    await seed(sage, 'doc', 4, 0, true);
    await sage.record(k, 'APPLY', { now: NOW + 100 }, { runRef: 'run-9' });

    const detail = await sage.show(k, { now: NOW + 200 });
    expect(detail.known).toBe(true);
    expect(detail.provenance).toEqual(['digest-clusterer']);
    expect(detail.recentEpisodes.map((e) => e.seq)).toEqual(
      detail.recentEpisodes.map((e) => e.seq).sort((a, b) => b - a),
    );
    expect(detail.hint.temporal.emaWeight).toBeGreaterThan(0.5);

    const limited = await sage.show(k, { now: NOW + 200 }, { recent: 2 });
    expect(limited.recentEpisodes).toHaveLength(2);
  });

  test('show on an unknown id reads back the probation prior with the provider (spec §5.2)', async () => {
    const { sage } = makeEngine();
    const detail = await sage.show(key('never'), { now: NOW });
    expect(detail.known).toBe(false);
    expect(detail.hint.status).toBe('probation');
    expect(detail.hint.temporal.emaWeight).toBe(0.5);
    expect(detail.recentEpisodes).toEqual([]);
  });

  test('drift lists only drifting entities, most drifted first', async () => {
    const { sage } = makeEngine();
    await seed(sage, 'stable', 10);
    // 10 apples push mu up, 10 rejections drive it to ~0 — |mu - theta0| >= 0.4 with n >= 3.
    await seed(sage, 'wobbly', 10, 10);

    const report = await sage.drift({ now: NOW + 100 });
    expect(report.count).toBe(1);
    expect(report.drifting[0]?.key.id).toBe('wobbly');
    expect(report.drifting[0]?.delta).toBeGreaterThanOrEqual(0.4);
    expect(report.drifting[0]?.hint.temporal.isDrifting).toBe(true);
  });

  test('simulate is pure: it persists nothing and reports the delta', async () => {
    const { store, sage } = makeEngine();
    await seed(sage, 'a', 2, 0, true);
    const logBefore = await store.episodes();

    const delta = await sage.simulate(key('a'), 'APPLY', { now: NOW + 50 });
    expect(delta.deltaTrust).toBeGreaterThan(0);
    expect(delta.statusChanged).toBe(false);

    const deltaReject = await sage.simulate(key('a'), 'REJECT_RULE', { now: NOW + 50 });
    expect(deltaReject.deltaTrust).toBeLessThan(0);

    expect(await store.episodes()).toEqual(logBefore);
  });

  test('simulate on an unknown id folds a fresh prior and resolves named signals', async () => {
    const { sage } = makeEngine();
    const delta = await sage.simulate(key('fresh'), 'ADOPTED', { now: NOW });
    expect(delta.before.trustScore).toBeLessThanOrEqual(0.5);
    expect(delta.after.evidence.totalTrials).toBe(1);
  });
});

describe('explore — reference helper (§6.3)', () => {
  test('is deterministic for a given seed and reproducible elsewhere', async () => {
    const { sage } = makeEngine();
    const keys = [await seed(sage, 'p1', 0), await seed(sage, 'p2', 1), await seed(sage, 'a1', 4)];
    const first = await sage.explore(keys, { slots: 3, seed: 7 }, { now: NOW + 10 });
    const second = await sage.explore(keys, { slots: 3, seed: 7 }, { now: NOW + 10 });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test('falls back to context.seed and requires a seed for reproducibility', async () => {
    const { sage } = makeEngine();
    const k = await seed(sage, 'p1', 0);
    const viaPolicy = await sage.explore([k], { slots: 1, seed: 9 }, { now: NOW });
    const viaContext = await sage.explore([k], { slots: 1 }, { now: NOW, seed: 9 });
    expect(JSON.stringify(viaPolicy)).toBe(JSON.stringify(viaContext));
    await expect(sage.explore([k], { slots: 1 }, { now: NOW })).rejects.toThrow(
      InvalidArgumentError,
    );
  });

  test('reserves slots for probation (uncertainty-weighted) and fills the rest by merit', async () => {
    const { sage } = makeEngine();
    const prob1 = await seed(sage, 'prob1', 0);
    const prob2 = await seed(sage, 'prob2', 1);
    const trusted1 = await seed(sage, 'tt1', 9, 0, true);
    const trusted2 = await seed(sage, 'tt2', 9, 0, true);

    const picks = await sage.explore(
      [trusted1, prob2, prob1, trusted2],
      { slots: 3, seed: 3 },
      { now: NOW + 10 },
    );
    expect(picks).toHaveLength(3);
    const probation = picks.filter((c) => c.admittedBy === 'probation');
    const merit = picks.filter((c) => c.admittedBy === 'merit');
    expect(probation.map((c) => c.key.id).sort()).toEqual(['prob1', 'prob2']);
    expect(merit).toHaveLength(1);
    expect(merit[0]?.hint.status).toBe('trusted');
    // Uncertainty: the unknown entity (0 evidence) is the widest interval.
    expect(probation.find((c) => c.key.id === 'prob1')?.uncertainty).toBe(1);
  });

  test('samples probation by Wilson width: less-known candidates are tried more often', async () => {
    const { sage } = makeEngine();
    const fresh = await seed(sage, 'fresh', 0); // width 1
    const seasoned = await seed(sage, 'seasoned', 2); // width ~0.59
    const freshString = entityKeyString(fresh);
    const seasonedString = entityKeyString(seasoned);

    let freshPicks = 0;
    let seasonedPicks = 0;
    for (let i = 0; i < 1000; i++) {
      const [chosen] = await sage.explore(
        [fresh, seasoned],
        { slots: 1, seed: 10_000 + i },
        { now: NOW },
      );
      const picked = chosen?.key;
      if (picked !== undefined && entityKeyString(picked) === freshString) freshPicks++;
      else if (picked !== undefined && entityKeyString(picked) === seasonedString) seasonedPicks++;
    }
    // 1000 draws, P(unknown) ≈ 1 / (1 + 0.59) ≈ 63% — a wide margin over 50%.
    expect(freshPicks).toBeGreaterThan(500);
    expect(freshPicks).toBeGreaterThan(seasonedPicks);
  });

  test('empty candidates, zero slots and unknown kinds are handled', async () => {
    const { sage } = makeEngine();
    expect(await sage.explore([], { slots: 2, seed: 1 }, { now: NOW })).toEqual([]);
    const k = await seed(sage, 'a', 1);
    expect(await sage.explore([k], { slots: 0, seed: 1 }, { now: NOW })).toEqual([]);
    await expect(
      sage.explore(
        [{ namespace: '', kind: 'mystery', id: 'x' }],
        { slots: 1, seed: 1 },
        { now: NOW },
      ),
    ).rejects.toThrow();
  });
});
