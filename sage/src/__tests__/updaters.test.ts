import { describe, expect, test } from 'bun:test';
import { APPLY, InvalidArgumentError, REJECT_RULE } from '@cntxt-labs/medha-core';
import {
  asymmetricUpdater,
  emaUpdater,
  getBuiltinUpdater,
  slidingWindowUpdater,
  UpdaterRegistry,
  type WeightUpdateContext,
  type WeightUpdateOutcome,
  wilsonUpdater,
} from '../updaters.ts';

/**
 * Weight-updater port (Loom-ujs3.7): built-in math mirrors the legacy expectations (module
 * `sage-weight-updater.test.ts`), the 3-tier registry honours project → user → built-in, and
 * computeWeightSafe falls back to EMA with the fallback always reported.
 */

const NOW = 1_700_000_000_000;

const makeContext = (overrides: Partial<WeightUpdateContext> = {}): WeightUpdateContext => ({
  key: { namespace: '', kind: 'rule', id: 'RULE-01' },
  currentWeight: 0.5,
  initialWeight: 0.5,
  signal: APPLY,
  sampleCount: 5,
  acceptanceCount: 4,
  contextRejectCount: 1,
  rejectRuleCount: 1,
  parameters: { mu: 0.5, theta0: 0.5, updatedAt: NOW },
  ...overrides,
});

const newWeightOf = (raw: WeightUpdateOutcome | number): number =>
  typeof raw === 'number' ? raw : raw.newWeight;

const asOutcome = (raw: WeightUpdateOutcome | number): WeightUpdateOutcome =>
  typeof raw === 'number' ? { newWeight: raw } : raw;

describe('built-in strategies — legacy math parity', () => {
  test('ema computes the exponential moving average +1.0 @ 0.5 → 0.55', () => {
    const outcome = emaUpdater.computeWeight(makeContext({ signal: APPLY }));
    expect(newWeightOf(outcome)).toBe(0.55);
  });

  test('wilson computes the statistical lower bound once stabilised', () => {
    const outcome = asOutcome(
      wilsonUpdater.computeWeight(
        makeContext({ sampleCount: 20, acceptanceCount: 18, signal: APPLY }),
      ),
    );
    expect(outcome.newWeight).toBeGreaterThan(0.7);
    expect(outcome.newWeight).toBeLessThanOrEqual(1.0);
    expect(outcome.metadata).toMatchObject({ totalPositive: 19, totalSamples: 21 });
  });

  test('wilson blends with the prior until 5 samples accumulate', () => {
    const fresh = asOutcome(
      wilsonUpdater.computeWeight(
        makeContext({ sampleCount: 0, acceptanceCount: 0, signal: APPLY }),
      ),
    );
    expect(fresh.newWeight).toBeGreaterThanOrEqual(0.25); // 0.5 * 0.5 + 0.5 * (1/1)
    expect(fresh.newWeight).toBeLessThanOrEqual(0.75);
    expect(fresh.isDrifting).toBe(false);
  });

  test('sliding-window applies a bounded step update', () => {
    const outcome = asOutcome(
      slidingWindowUpdater.computeWeight(makeContext({ currentWeight: 0.5, signal: APPLY })),
    );
    expect(outcome.newWeight).toBeGreaterThan(0.5);
    expect(outcome.newWeight).toBeLessThan(0.6);
  });

  test('asymmetric-penalty applies a severe penalty on REJECT_RULE', () => {
    const applyOutcome = asymmetricUpdater.computeWeight(
      makeContext({ currentWeight: 0.8, signal: APPLY }),
    );
    const rejectOutcome = asymmetricUpdater.computeWeight(
      makeContext({ currentWeight: 0.8, signal: REJECT_RULE }),
    );
    expect(newWeightOf(applyOutcome)).toBeGreaterThan(0.8);
    expect(newWeightOf(rejectOutcome)).toBe(0.6); // 0.8 - (0.25 * 0.8) = 0.60
  });

  test('getBuiltinUpdater falls back to ema for unknown names', () => {
    expect(getBuiltinUpdater('ema').name).toBe('ema');
    expect(getBuiltinUpdater('asymmetric').name).toBe('asymmetric-penalty');
    expect(getBuiltinUpdater('no-such-thing').name).toBe('ema');
  });
});

describe('updater registry — tiers', () => {
  const fixed = (name: string, newWeight: number) => ({
    name,
    computeWeight: () => ({ newWeight }),
  });

  test('project shadows user shadows built-in', () => {
    const registry = new UpdaterRegistry();
    registry.register(fixed('shared', 0.7), 'user');
    registry.register(fixed('shared', 0.8), 'project');
    expect(registry.resolve('shared')?.name).toBe('shared');
    expect(registry.computeWeightSafe(makeContext(), 'shared').outcome.newWeight).toBe(0.8);

    const userOnly = new UpdaterRegistry();
    userOnly.register(fixed('shared', 0.7), 'user');
    expect(userOnly.computeWeightSafe(makeContext(), 'shared').outcome.newWeight).toBe(0.7);
  });

  test('domains route through storeOverrides, default otherwise', () => {
    const registry = new UpdaterRegistry({
      defaultUpdater: 'ema',
      storeOverrides: { reviewer: 'wilson', security: 'asymmetric-penalty' },
    });
    expect(
      registry.computeWeightSafe(makeContext({ sampleCount: 20, acceptanceCount: 18 }), 'reviewer')
        .updaterName,
    ).toBe('wilson');
    expect(registry.computeWeightSafe(makeContext(), 'security').updaterName).toBe(
      'asymmetric-penalty',
    );
    expect(registry.computeWeightSafe(makeContext(), 'other-domain').updaterName).toBe('ema');
  });

  test('computeWeightSafe reports the EMA fallback when the updater throws', () => {
    const registry = new UpdaterRegistry();
    registry.register(
      {
        name: 'buggy',
        computeWeight: () => {
          throw new InvalidArgumentError('simulated crash', 'n/a', 'n/a');
        },
      },
      'project',
    );
    const result = registry.computeWeightSafe(makeContext({ signal: APPLY }), 'buggy');
    expect(result.updaterName).toBe('ema');
    expect(result.fallbackFrom).toBe('buggy');
    expect(result.error).toBeDefined();
    expect(result.outcome.newWeight).toBe(0.55);
  });

  test('an unresolvable name falls back to EMA with the name reported', () => {
    const registry = new UpdaterRegistry();
    const result = registry.computeWeightSafe(makeContext(), 'no-such-updater');
    expect(result.updaterName).toBe('ema');
    expect(result.fallbackFrom).toBe('no-such-updater');
  });

  test('a non-finite weight is treated as a failure and falls back to EMA', () => {
    const registry = new UpdaterRegistry();
    registry.register(
      { name: 'nan-machine', computeWeight: () => ({ newWeight: Number.NaN }) },
      'project',
    );
    const result = registry.computeWeightSafe(makeContext(), 'nan-machine');
    expect(result.updaterName).toBe('ema');
    expect(result.error).toBeDefined();
  });

  test('listUpdaters reports the built-ins and the registered tiers, deduped', () => {
    const registry = new UpdaterRegistry({ user: { mine: fixed('mine', 0.5) } });
    registry.register(fixed('also-mine', 0.6), 'project');
    const list = registry.listUpdaters();
    const names = list.map((u) => u.name);
    expect(names).toContain('ema');
    expect(names).toContain('wilson');
    expect(names).toContain('sliding-window');
    expect(names).toContain('asymmetric-penalty');
    expect(names).toContain('mine');
    expect(names).toContain('also-mine');
    expect(list.find((u) => u.name === 'also-mine')?.source).toBe('project');
    expect(list.find((u) => u.name === 'mine')?.source).toBe('user');
    // The `asymmetric` alias must not surface as a second `asymmetric-penalty` row.
    expect(names.filter((n) => n === 'asymmetric-penalty')).toHaveLength(1);
    expect(new Set(names).size).toBe(names.length);
  });
});
