import { describe, expect, test } from 'bun:test';
import { type EntityKey, InvalidArgumentError } from '@cntxt-labs/medha-core';
import { MemoryStore } from '@cntxt-labs/medha-store';
import { Sage } from '../engine.ts';

/**
 * Write plane (§6.2) acceptance: every mutation writes an episode; the weight-updater runs through
 * the registry and its EMA fallback is *reported*; override transitions are recorded; a guard
 * report changes G (and trust/status) but Sage executes nothing else.
 */

const NOW = 1_700_000_000_000;
const KEY: EntityKey = { namespace: 'ns', kind: 'rule', id: 'r1' };
const ctx = { now: NOW };
const HOST_KIND = 'host';

function makeEngine() {
  const store = new MemoryStore({
    registries: { kinds: [HOST_KIND], signalSpecs: [], anchorKinds: ['week'] },
  });
  return { store, sage: new Sage({ store }) };
}

// Register each custom updater with a distinct weight so the registry route is unambiguous.
function fixedUpdater(name: string, newWeight: number) {
  return { name, computeWeight: () => ({ newWeight }) };
}

describe('write plane — record (§6.2)', () => {
  test('writes an episode for every signal and returns the new hint plus updater usage', async () => {
    const { store, sage } = makeEngine();
    const out = await sage.record(KEY, 'APPLY', ctx, {
      ensure: true,
      runRef: 'run-1',
      note: 'ran twice in CI',
    });
    expect(out.updater?.name).toBe('ema');
    expect(out.hint.evidence.successes).toBe(1);
    expect(out.state?.ema.mu).toBe(0.55);

    const log = await store.episodes();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      type: 'signal',
      ensure: true,
      runRef: 'run-1',
      note: 'ran twice in CI',
    });
    expect((log[0] as { updater?: string }).updater).toBe('ema');
    expect((log[0] as { weight?: number }).weight).toBe(0.55);
  });

  test('records a signal with an anchor and returns the growth it produced', async () => {
    const { sage } = makeEngine();
    const out = await sage.record(KEY, 'REJECT_RULE', ctx, {
      ensure: true,
      anchor: { kind: 'git', value: 'abc1234' },
    });
    expect(out.state?.evidence.n).toBe(1);
    // Rejections are not successes, and an anchor is only kept on a successful use.
    expect(out.state?.evidence.k).toBe(0);
    expect(out.state?.anchors).toEqual([]);
    // REJECT_RULE (−1.0) from the 0.5 prior lands on emaStep(0.5, −1) = 0.9·0.5 − 0.1 = 0.35.
    expect(out.hint.temporal.emaWeight).toBe(0.35);
  });

  test('a signal with an anchor on a success is durable', async () => {
    const { sage } = makeEngine();
    const out = await sage.record(KEY, 'APPLY', ctx, {
      ensure: true,
      anchor: { kind: 'git', value: 'abc1234' },
    });
    expect(out.state?.anchors).toEqual([{ kind: 'git', value: 'abc1234' }]);
  });

  test('an un-ensured signal on an unknown id is a logged no-op (spec §5.2)', async () => {
    const { store, sage } = makeEngine();
    const out = await sage.record({ namespace: '', kind: 'tool', id: 'never' }, 'APPLY', ctx);
    expect(out.state).toBeUndefined();
    expect(out.updater).toBeUndefined();
    expect(out.hint.status).toBe('probation');
    expect(await store.episodes()).toHaveLength(1);
  });

  test('a custom updater is reachable from the write path — not just the four built-ins', async () => {
    const { store, sage } = makeEngine();
    sage.updaters.register(fixedUpdater('fixed-delta', 0.99), 'project');
    const out = await sage.record(KEY, 'APPLY', ctx, { ensure: true, updater: 'fixed-delta' });
    expect(out.updater?.name).toBe('fixed-delta');
    expect(out.hint.temporal.emaWeight).toBe(0.99);
    expect(out.state?.ema.mu).toBe(0.99);

    // Fold-equivalence holds: the embedded weight is self-describing in the episode.
    const rebuilt = await store.rebuild();
    expect(rebuilt[0]?.ema.mu).toBe(0.99);
  });

  test('an updater that throws falls back to EMA and the fallback is reported', async () => {
    const { sage } = makeEngine();
    sage.updaters.register(
      {
        name: 'buggy',
        computeWeight: () => {
          throw new InvalidArgumentError('simulated crash', 'n/a', 'n/a');
        },
      },
      'project',
    );
    const out = await sage.record(KEY, 'APPLY', ctx, { ensure: true, updater: 'buggy' });
    expect(out.updater?.name).toBe('ema');
    expect(out.updater?.fallbackFrom).toBe('buggy');
    expect(out.updater?.error).toBeDefined();
    expect(out.hint.temporal.emaWeight).toBe(0.55);
  });

  test('the entity-level updater is honoured when record does not override it', async () => {
    const { sage } = makeEngine();
    // Host ships its belief about the strategy per kind; the engine reads state.updater.
    const out = await sage.record(KEY, 'APPLY', ctx, {
      ensure: true,
      updater: 'asymmetric-penalty',
    });
    expect(out.updater?.name).toBe('asymmetric-penalty');
    expect(out.state?.ema.mu).toBeCloseTo(0.52, 6); // 0.5 + 0.04*(1-0.5)
  });
});

describe('write plane — reportGuard (§6.2)', () => {
  test('changes G and therefore trust, appending exactly one episode — executes nothing', async () => {
    const { store, sage } = makeEngine();
    await sage.record(KEY, 'APPLY', ctx, { ensure: true });
    await sage.record(KEY, 'APPLY', { now: NOW + 1 });
    const before = await sage.hints([KEY], { now: NOW + 2 });

    const after = await sage.reportGuard(KEY, { ok: true, kind: 'harness-ast' }, { now: NOW + 3 });
    expect(after.components.guard).toBe(1);
    expect(before.get(entityKey(KEY))?.components.guard).toBe(0.5);
    expect(after.components.guard).toBeGreaterThan(
      before.get(entityKey(KEY))?.components.guard ?? 0,
    );

    // Exactly the guard episode was added; no signal, no sweep, nothing else executed.
    const log = await store.episodes();
    expect(log).toHaveLength(3);
    expect(log[2]).toMatchObject({ type: 'guard', ok: true, kind: 'harness-ast' });
  });

  test('a failed guard zeroes G and quarantines the entity', async () => {
    const { sage } = makeEngine();
    await sage.record(KEY, 'APPLY', ctx, { ensure: true });
    const hint = await sage.reportGuard(KEY, { ok: false, kind: 'harness-ast' }, { now: NOW + 1 });
    expect(hint.components.guard).toBe(0);
    expect(hint.status).toBe('quarantined');
    expect(hint.trustScore).toBe(0);
  });

  test('report.at overrides context.now as the episode clock (determinism preserved)', async () => {
    const { sage } = makeEngine();
    await sage.record(KEY, 'APPLY', { now: NOW }, { ensure: true });
    const hint = await sage.reportGuard(
      KEY,
      { ok: true, at: NOW + 5000, kind: 'harness-ast' },
      { now: NOW },
    );
    expect(hint.asOf).toBe(NOW);
    expect((await sage.store.episodes())[1]?.at).toBe(NOW + 5000);
    expect(hint.components.guard).toBe(1);
  });
});

describe('write plane — override (§6.2)', () => {
  test('records the override episode and transitions the lifecycle', async () => {
    const { store, sage } = makeEngine();
    await sage.record(KEY, 'APPLY', ctx, { ensure: true });
    await sage.record(KEY, 'APPLY', { now: NOW + 1 });

    const hint = await sage.override(KEY, 'retire', { now: NOW + 2 }, 'deprecated in favour of v2');
    expect(hint).not.toBeNull();
    expect(hint?.status).toBe('retired');
    expect(hint?.trustScore).toBe(0);

    const log = await store.episodes();
    expect(log[log.length - 1]).toMatchObject({
      type: 'override',
      override: 'retired',
      reason: 'deprecated in favour of v2',
    });
  });

  test('quarantine and restore both transition cleanly', async () => {
    const { sage } = makeEngine();
    await sage.record(KEY, 'APPLY', ctx, { ensure: true });
    const quarantined = await sage.override(KEY, 'quarantine', { now: NOW + 1 }, 'incident');
    expect(quarantined?.status).toBe('quarantined');
    const restored = await sage.override(KEY, 'restore', { now: NOW + 2 }, 'resolved');
    expect(restored?.status).toBe('probation');
  });

  test('an override on an unknown entity is a logged no-op returning null', async () => {
    const { store, sage } = makeEngine();
    const result = await sage.override(
      { namespace: '', kind: 'tool', id: 'missing' },
      'retire',
      ctx,
      'x',
    );
    expect(result).toBeNull();
    const log = await store.episodes();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ type: 'override' });
    expect(await sage.store.get({ namespace: '', kind: 'tool', id: 'missing' })).toBeUndefined();
  });
});

function entityKey(k: EntityKey): string {
  return `${k.namespace}\u0000${k.kind}\u0000${k.id}`;
}
