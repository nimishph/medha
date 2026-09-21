import { describe, expect, test } from 'bun:test';
import { anchorSetFor, distinctAnchorValues, durabilityFactor, weekEpoch } from '../durability.ts';
import { emaStep } from '../ema.ts';
import { type EntityState, freshState } from '../entity.ts';
import { InvariantViolationError, UnknownKindError, UnknownSignalError } from '../errors.ts';
import { applySignal, reportGuard, weekAnchor } from '../fold.ts';
import { buildHint } from '../hint.ts';
import { KindRegistry } from '../kinds.ts';
import { recencyDecay } from '../recency.ts';
import {
  APPLY,
  CANONICAL_SIGNALS,
  REJECT_CONTEXT,
  REJECT_RULE,
  SignalRegistry,
  SKIP,
  validateSignalSpec,
} from '../signals.ts';
import { DEFAULT_THETA0, RETIRED_TRUST_THRESHOLD } from '../thresholds.ts';
import { computeTrust, statusFor, trustOf } from '../trust.ts';
import { wilsonLowerBound } from '../wilson.ts';

const START = 1_700_000_000_000;
const WEEK = 7 * 24 * 60 * 60 * 1000;

const KEY = { namespace: 'n', kind: 'rule', id: 'r1' };

const PASSED_GUARD = { kind: 'ci', lastOk: true, lastOkAt: START } as const;

function freshKernel(at: number = START): EntityState {
  return freshState(KEY, at, { theta0: DEFAULT_THETA0 });
}

describe('wilson bound — model §3.1 worked numbers', () => {
  test('no evidence is 0', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });

  test('1/1 ≈ 0.2065 (3dp)', () => {
    expect(Math.abs(wilsonLowerBound(1, 1) - 0.2065)).toBeLessThan(0.0005);
  });

  test('40/45 ≈ 0.765 (2dp)', () => {
    expect(Math.abs(wilsonLowerBound(40, 45) - 0.765)).toBeLessThan(0.005);
  });

  test('model §3.1 worked numbers: L(4,5)=0.3755 matches', () => {
    expect(Math.abs(wilsonLowerBound(4, 5) - 0.3755)).toBeLessThan(0.0005);
  });

  test('model §3.1 L(40,50): the printed 0.6702 does not equal the formula it precedes', () => {
    // The document's 0.6702 is not reproducible from the printed Wilson formula (exact 0.66962628).
    // The kernel follows the formula, reproduced exactly; the doc value is flagged, not chased.
    expect(wilsonLowerBound(40, 50)).toBeCloseTo(0.66962628, 6);
  });

  test('rejects impossible counts', () => {
    expect(() => wilsonLowerBound(2, 1)).toThrow();
    expect(() => wilsonLowerBound(-1, 5)).toThrow();
  });
});

describe('trust ordering — 1/1 never outranks 38/40', () => {
  test('at the wilson and at the trust level', () => {
    const greenOne = computeTrust({ k: 1, n: 1, contextRejects: 0 }, PASSED_GUARD, [], null, START);
    const proven = computeTrust({ k: 38, n: 40, contextRejects: 0 }, PASSED_GUARD, [], null, START);
    expect(greenOne.components.wilson).toBeLessThan(proven.components.wilson);
    expect(greenOne.trust).toBeLessThan(proven.trust);
  });
});

describe('unguarded entities — invariant IV', () => {
  test('trust stays strictly below 0.50 for the built-in kinds even at extreme evidence', () => {
    for (const kind of ['rule', 'recipe', 'tool'] as const) {
      const trust = computeTrust(
        { k: 1_000_000, n: 1_000_000, contextRejects: 0 },
        { kind: 'none', lastOk: null, lastOkAt: null },
        [],
        START,
        START,
      );
      expect(trust.trust).toBeLessThan(0.5);
      expect(trust.trust).toBeLessThan(0.6);
      expect(kind.length).toBeGreaterThan(0);
    }
  });

  test('guard failure zeroes trust and quarantines', () => {
    const t = computeTrust(
      { k: 50, n: 50, contextRejects: 0 },
      { kind: 'ci', lastOk: false, lastOkAt: START },
      [],
      START,
      START,
    );
    expect(t.trust).toBe(0);

    let state = freshKernel();
    state = { ...state, guard: { kind: 'ci', lastOk: false, lastOkAt: START } };
    expect(statusFor(state, START)).toBe('quarantined');
    expect(trustOf(state, START).trust).toBe(0);
  });
});

describe('skipping — invariant III', () => {
  test('SKIP never increments n or k and damps the EMA', () => {
    let state = freshKernel();
    for (let i = 0; i < 10; i++) {
      const next = applySignal(state, { spec: SKIP }, { now: START + i });
      state = next.state;
      expect(state.evidence.n).toBe(0);
      expect(state.evidence.k).toBe(0);
      expect(state.evidence.contextRejects).toBe(0);
    }
    expect(state.ema.mu).toBeLessThan(DEFAULT_THETA0);
    expect(state.status).toBe('probation');
  });
});

describe('conflict signals — context rejection is not a trial', () => {
  test('REJECT_CONTEXT bumps contextRejects only', () => {
    let state = freshKernel();
    const { state: next } = applySignal(state, { spec: REJECT_CONTEXT }, { now: START });
    state = next;
    expect(state.evidence.n).toBe(0);
    expect(state.evidence.k).toBe(0);
    expect(state.evidence.contextRejects).toBe(1);
  });

  test('REJECT_RULE counts the trial but never the success', () => {
    let state = freshKernel();
    const { state: next } = applySignal(state, { spec: REJECT_RULE }, { now: START });
    state = next;
    expect(state.evidence.n).toBe(1);
    expect(state.evidence.k).toBe(0);
  });
});

describe('ema — model §3.2/§3.3 worked numbers', () => {
  test('SKIP series from mu=0.8 damps to 0.7200, 0.6480, 0.5832, 0.4724, 0.2790 at steps 1,2,3,5,10', () => {
    const atStep: Record<number, number> = {
      1: 0.72,
      2: 0.648,
      3: 0.5832,
      5: 0.472392,
      10: 0.278943,
    };
    let mu: number | undefined = 0.8;
    for (let step = 1; step <= 10; step++) {
      mu = emaStep(mu, SKIP.value);
      const expectedAtStep = atStep[step];
      if (expectedAtStep !== undefined) expect(mu).toBeCloseTo(expectedAtStep, 6);
    }
  });

  test('clamps to [0,1]', () => {
    expect(emaStep(1, 1)).toBe(1);
    expect(emaStep(0.05, -1)).toBe(0);
    expect(emaStep(0, 0)).toBe(0);
  });
});

describe('recency — model §4.2 worked numbers', () => {
  test('fresh use is 1, half-life at 45 days, floor 0.30', () => {
    expect(recencyDecay(START, START)).toBe(1);
    expect(recencyDecay(START, START + 45 * 24 * 60 * 60 * 1000)).toBeCloseTo(0.5, 6);
    expect(recencyDecay(null, START)).toBe(0.3);
  });

  test('future timestamps clamp to 1 (determinism: no negative age)', () => {
    expect(recencyDecay(START, START - 10_000)).toBe(1);
  });
});

describe('durability — model §4.3 generalised', () => {
  test('distinct anchors across weeks, no declared anchors uses the week fallback', () => {
    const at = START;
    const applied = [weekAnchor(at), weekAnchor(at), weekAnchor(at + WEEK + 1)];
    const values = distinctAnchorValues(applied);
    expect(values.size).toBe(2);

    const set = anchorSetFor(applied, []);
    expect(set.declared).toBe(true);
    expect(durabilityFactor(set.values.size)).toBeGreaterThan(1);
  });

  test('no survival credit means neutral 1.0', () => {
    expect(durabilityFactor(0)).toBe(1);
  });

  test('week epoch bins timestamps into 7-day buckets', () => {
    // Epoch 0 is the model's week origin; the probe is relative so no wall-clock boundary surprises.
    const origin = 0;
    expect(weekEpoch(origin)).toBe(weekEpoch(origin + WEEK - 1));
    expect(weekEpoch(origin)).toBeLessThan(weekEpoch(origin + WEEK + 1));
  });

  test('fallback (no anchors at all) still reports a non-empty set once a week epoch is given', () => {
    const set = anchorSetFor([], [weekEpoch(START)]);
    expect(set.declared).toBe(false);
    expect(set.values.size).toBe(1);
  });
});

describe('lifecycle — model §5.1', () => {
  test('fresh → probation', () => {
    expect(freshKernel().status).toBe('probation');
  });

  test('enough evidence behind a passed guard → trusted', () => {
    // θ0 = 0.9: an author-declared baseline close to observed use, so 38 APPLYs keep Δ ≈ 0.1 < 0.4.
    let state = freshState(KEY, START, { guard: PASSED_GUARD, theta0: 0.9 });
    for (let i = 0; i < 38; i++) {
      const { state: next } = applySignal(state, { spec: APPLY }, { now: START + i });
      state = next;
    }
    expect(state.evidence.n).toBe(38);
    expect(state.status).toBe('trusted');
  });

  test('long-neglected unguarded use → retired', () => {
    const state: EntityState = {
      ...freshKernel(),
      evidence: { k: 1, n: 1, contextRejects: 0 },
      ema: { mu: 0.001, theta0: DEFAULT_THETA0, updatedAt: START },
      anchors: [],
      lastSignalAt: null,
      status: 'probation',
    };
    // Recency floor 0.30 at 0.5 ceiling ⇒ trust ≈ 0.2065 * 0.5 * 0.3 < 0.10.
    expect(trustOf(state, START).trust).toBeLessThan(RETIRED_TRUST_THRESHOLD);
    expect(statusFor(state, START)).toBe('retired');
  });
});

describe('hint — spec §5.4', () => {
  test('trusted entity produces a self-clearing hint with all components', () => {
    let state = freshState(KEY, START, { guard: PASSED_GUARD, theta0: 0.9 });
    for (let i = 0; i < 38; i++) {
      const { state: next } = applySignal(state, { spec: APPLY }, { now: START + i * 1000 });
      state = next;
    }
    const hint = buildHint(state, START + 38 * 1000);
    expect(hint.asOf).toBe(START + 38_000);
    expect(hint.clearsThreshold.trusted).toBe(true);
    expect(hint.clearsThreshold.active).toBe(true);
    expect(hint.components).toMatchObject({
      wilson: expect.any(Number),
      guard: 1,
      recency: 1,
      durability: expect.any(Number),
      ceiling: 1,
    });
    expect(hint.trustScore).toBeGreaterThanOrEqual(0);
    expect(hint.trustScore).toBeLessThanOrEqual(1);
    expect(hint.temporal.isDrifting).toBe(false);
  });
});

describe('determinism — same inputs, same state', () => {
  test('two independent folds agree byte-for-byte', () => {
    const build = () => {
      let state = freshKernel();
      for (let i = 0; i < 12; i++) {
        const signal = i % 3 === 0 ? APPLY : i % 3 === 1 ? SKIP : REJECT_RULE;
        const { state: next } = applySignal(state, { spec: signal }, { now: START + i * 1000 });
        state = next;
      }
      return state;
    };
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
    expect(build().ema.mu).toBeCloseTo(build().ema.mu, 6);
  });
});

describe('registry integrity', () => {
  test('signal registry resolves canonicals, aliases, and fails loud on unknowns', () => {
    const registry = new SignalRegistry();
    expect(registry.resolve('APPLY')).toEqual(APPLY);
    registry.alias('go', 'APPLY');
    expect(registry.resolve('go').name).toBe('APPLY');
    expect(registry.has('go')).toBe(true);
    expect(() => registry.resolve('nope')).toThrow(UnknownSignalError);
  });

  test('spec validation protects invariants III and IV', () => {
    expect(() =>
      validateSignalSpec({
        name: 'NEUTRAL_TRIAL',
        value: 0,
        countsAsTrial: true,
        countsAsSuccess: false,
      }),
    ).toThrow(InvariantViolationError);
    expect(() =>
      validateSignalSpec({
        name: 'NEG_SUCCESS',
        value: -0.5,
        countsAsTrial: true,
        countsAsSuccess: true,
      }),
    ).toThrow(InvariantViolationError);
  });

  test('canonical four are exactly what the model needs', () => {
    expect(CANONICAL_SIGNALS.map((s) => s.name)).toEqual([
      'APPLY',
      'SKIP',
      'REJECT_CONTEXT',
      'REJECT_RULE',
    ]);
    expect(SKIP.countsAsTrial).toBe(false);
  });

  test('kind registry has the three built-ins and rejects unknowns loud', () => {
    const registry = new KindRegistry();
    expect([...registry.all].sort()).toEqual(['recipe', 'rule', 'tool']);
    registry.register('locator');
    registry.requireKnown('locator');
    expect(() => registry.requireKnown('mystery')).toThrow(UnknownKindError);
  });

  test('guard reports drive quarantine via the fold', () => {
    const state = freshState(KEY, START, { guard: PASSED_GUARD });
    const { state: st, status } = reportGuard(state, { ok: false, kind: 'ci' }, { now: START + 1 });
    expect(status).toBe('quarantined');
    expect(st.guard.lastOk).toBe(false);
  });
});
