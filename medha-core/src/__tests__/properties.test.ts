import { describe, expect, test } from 'bun:test';
import { durabilityFactor } from '../durability.ts';
import { isDrifting, isDriftingDown } from '../ema.ts';
import { type EntityState, freshState } from '../entity.ts';
import { applySignal, overrideStatus, reportGuard } from '../fold.ts';
import { evaluateGates } from '../hint.ts';
import type { KindSpec } from '../kinds.ts';
import { recencyDecay } from '../recency.ts';
import { mulberry32, type SeededRng } from '../rng.ts';
import { APPLY, REJECT_CONTEXT, REJECT_RULE, SKIP } from '../signals.ts';
import { DAY_MS } from '../thresholds.ts';
import { composeTrust, statusFrom, trustOf } from '../trust.ts';
import { wilsonLowerBound } from '../wilson.ts';

/**
 * Property tests for the trust math. Deterministic: every run uses fixed seeds, and a failure
 * reports its seed so it can be replayed. Monotonicity is stated per component and per
 * composition step; the places where the folded score is knowingly non-monotone are pinned in
 * "documented non-monotonicities" so a decision to change them shows up as a test change.
 */

const T0 = 1_700_000_000_000;
const KEY = { namespace: 'n', kind: 'rule', id: 'r' };
const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);

const pick = <T>(rng: SeededRng, items: readonly T[]): T =>
  items[Math.floor(rng() * items.length)] as T;

describe('component monotonicity', () => {
  test('Wilson lower bound is nondecreasing in k for fixed n', () => {
    for (let n = 1; n <= 300; n++) {
      let prev = -1;
      for (let k = 0; k <= n; k++) {
        const l = wilsonLowerBound(k, n);
        expect(l).toBeGreaterThanOrEqual(prev);
        prev = l;
      }
    }
  });

  test('a success never lowers the bound; a failure never raises it', () => {
    for (let n = 0; n <= 300; n++) {
      for (let k = 0; k <= n; k++) {
        const base = wilsonLowerBound(k, n);
        expect(wilsonLowerBound(k + 1, n + 1), `k=${k} n=${n}`).toBeGreaterThanOrEqual(base);
        expect(wilsonLowerBound(k, n + 1), `k=${k} n=${n}`).toBeLessThanOrEqual(base);
      }
    }
  });

  test('bounds: L in [0,1] and never above the raw ratio', () => {
    for (let n = 1; n <= 300; n++) {
      for (let k = 0; k <= n; k++) {
        const l = wilsonLowerBound(k, n);
        expect(l).toBeGreaterThanOrEqual(0);
        expect(l).toBeLessThanOrEqual(k / n + 1e-9);
      }
    }
  });

  test('recency is nonincreasing in age and stays within [floor, 1]', () => {
    for (const cfg of [
      undefined,
      { halfLifeDays: 10, floor: 0.5 },
      { halfLifeDays: 200, floor: 0 },
    ]) {
      let prev = 2;
      for (let d = 0; d <= 2000; d += 7) {
        const r = recencyDecay(T0, T0 + d * DAY_MS, cfg);
        expect(r).toBeLessThanOrEqual(prev);
        expect(r).toBeGreaterThanOrEqual(cfg?.floor ?? 0.3);
        expect(r).toBeLessThanOrEqual(1);
        prev = r;
      }
    }
  });

  test('durability is nondecreasing in anchors and capped at 1.5', () => {
    let prev = 0;
    for (let h = 0; h <= 5000; h++) {
      const d = durabilityFactor(h);
      expect(d).toBeGreaterThanOrEqual(prev);
      expect(d).toBeLessThanOrEqual(1.5);
      prev = d;
    }
  });

  test('composeTrust is nondecreasing in each factor and always within [0,1]', () => {
    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      const f = [rng(), pick(rng, [0, 0.5, 0.8, 1]), 0.3 + 0.7 * rng(), 1 + 0.5 * rng()] as const;
      const ceiling = pick(rng, [0.5, 1]);
      const base = composeTrust(f[0], f[1], f[2], f[3], ceiling);
      expect(base).toBeGreaterThanOrEqual(0);
      expect(base).toBeLessThanOrEqual(1);
      for (let i = 0; i < 4; i++) {
        const bumped = [...f] as [number, number, number, number];
        bumped[i] = (bumped[i] as number) * 1.1;
        const up = composeTrust(bumped[0], bumped[1], bumped[2], bumped[3], ceiling);
        expect(up, `seed ${seed} factor ${i}`).toBeGreaterThanOrEqual(base);
      }
    }
  });
});

interface Op {
  readonly kind: 'signal' | 'guard' | 'override';
  readonly name?: string;
  readonly ok?: boolean;
  readonly guardKind?: string | undefined;
  readonly override?: 'retired' | 'quarantined' | 'restore';
}

function randomKindSpec(rng: SeededRng): KindSpec {
  const thresholds =
    rng() < 0.7
      ? {
          trusted: pick(rng, [0.05, 0.2, 0.45, 0.6, 0.9]),
          active: pick(rng, [0.01, 0.25, 0.5]),
          minUsesForTrusted: pick(rng, [0, 1, 5, 20]),
          unguardedCeiling: pick(rng, [0.3, 0.5, 0.9]),
        }
      : undefined;
  return {
    name: 'rule',
    ...(thresholds ? { thresholds } : {}),
    ...(rng() < 0.3 ? { evidenceWeighting: 'signal-value' as const } : {}),
  };
}

function randomOps(rng: SeededRng, length: number): Op[] {
  const ops: Op[] = [];
  for (let i = 0; i < length; i++) {
    const r = rng();
    if (r < 0.6) {
      ops.push({
        kind: 'signal',
        name: pick(rng, ['APPLY', 'APPLY', 'REJECT_RULE', 'REJECT_CONTEXT', 'SKIP']),
      });
    } else if (r < 0.9) {
      ops.push({
        kind: 'guard',
        ok: rng() < 0.7,
        // Guard reports may rename the guard, including to 'none'.
        guardKind: pick(rng, ['ci', 'ci', 'harness', 'none', undefined]),
      });
    } else {
      ops.push({ kind: 'override', override: pick(rng, ['retired', 'quarantined', 'restore']) });
    }
  }
  return ops;
}

const SIGNALS = { APPLY, REJECT_RULE, REJECT_CONTEXT, SKIP } as const;

function step(state: EntityState, op: Op, at: number, kindSpec: KindSpec): EntityState {
  const ctx = { now: at, kindSpec };
  if (op.kind === 'signal') {
    return applySignal(state, { spec: SIGNALS[op.name as keyof typeof SIGNALS] }, ctx).state;
  }
  if (op.kind === 'guard') {
    return reportGuard(
      state,
      { ok: op.ok as boolean, ...(op.guardKind ? { kind: op.guardKind } : {}) },
      ctx,
    ).state;
  }
  return overrideStatus(state, op.override as 'retired' | 'quarantined' | 'restore').state;
}

const isUnguardedKind = (kind: string) => kind === 'none' || kind === '';

describe('model-based: trusted is unreachable without a passing guard', () => {
  test('after every step of random histories (random kind thresholds, guard renames, overrides)', () => {
    let trustedSeen = 0;
    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      const kindSpec = randomKindSpec(rng);
      const theta0 = pick(rng, [0.0, 0.5, 0.9, 1.0]);
      const guardKind = pick(rng, ['none', 'ci']);
      let state = freshState(KEY, T0, {
        theta0,
        guard: { kind: guardKind, lastOk: null, lastOkAt: null },
      });
      let now = T0;
      for (const op of randomOps(rng, 60)) {
        now += pick(rng, [1000, 60_000, 7 * DAY_MS, 90 * DAY_MS]);
        state = step(state, op, now, kindSpec);
        const result = trustOf(state, now, kindSpec);
        const status = statusFrom(state, result, kindSpec);
        const [trusted] = evaluateGates(state, result.trust, kindSpec);
        const why = `seed ${seed} after ${JSON.stringify(op)} guard=${JSON.stringify(state.guard)}`;
        if (status === 'trusted' || state.status === 'trusted' || trusted.met) {
          trustedSeen++;
          expect(state.guard.lastOk, why).toBe(true);
          expect(isUnguardedKind(state.guard.kind), why).toBe(false);
        }
        if (status === 'trusted') {
          expect(state.evidence.n, why).toBeGreaterThanOrEqual(
            kindSpec.thresholds?.minUsesForTrusted ?? 5,
          );
        }
      }
    }
    // Not vacuous: random histories must actually reach trusted for the property to mean anything.
    expect(trustedSeen).toBeGreaterThan(50);
  });
});

describe('model-based: bounds and invariants hold for every reachable state', () => {
  test('T in [0,1]; unguarded T below its ceiling; terminal states score 0; SKIP is inert', () => {
    for (const seed of SEEDS) {
      const rng = mulberry32(seed + 10_000);
      const kindSpec = randomKindSpec(rng);
      let state = freshState(KEY, T0, {
        theta0: pick(rng, [0, 0.5, 1]),
        guard: { kind: pick(rng, ['none', 'ci']), lastOk: null, lastOkAt: null },
      });
      let now = T0;
      for (const op of randomOps(rng, 50)) {
        now += pick(rng, [1000, DAY_MS, 30 * DAY_MS]);
        const before = state;
        state = step(state, op, now, kindSpec);
        const r = trustOf(state, now, kindSpec);
        const why = `seed ${seed} after ${JSON.stringify(op)}`;
        expect(r.trust, why).toBeGreaterThanOrEqual(0);
        expect(r.trust, why).toBeLessThanOrEqual(1);
        if (r.unguarded) {
          expect(r.trust, why).toBeLessThan(kindSpec.thresholds?.unguardedCeiling ?? 0.5);
        }
        if (state.status === 'quarantined' || state.status === 'retired') {
          expect(r.trust, why).toBe(0);
        }
        if (op.kind === 'signal' && op.name === 'SKIP') {
          expect(state.evidence, why).toEqual(before.evidence);
          expect(state.lastSignalAt, why).toBe(before.lastSignalAt);
        }
      }
    }
  });
});

describe('documented non-monotonicities (pinned: changing these is a spec decision)', () => {
  const guarded = (theta0: number, applies: number) => {
    let state = freshState(KEY, T0, {
      theta0,
      guard: { kind: 'ci', lastOk: true, lastOkAt: T0 },
    });
    for (let i = 0; i < applies; i++) {
      state = applySignal(state, { spec: APPLY }, { now: T0 + i * 1000 }).state;
    }
    return state;
  };

  test('sustained success does not quarantine: the drift gate is one-sided', () => {
    const now = T0 + 100_000;
    const few = guarded(0.5, 4);
    const many = guarded(0.5, 40);
    expect(trustOf(few, now).trust).toBeGreaterThan(0);
    expect(statusFrom(few, trustOf(few, now))).not.toBe('quarantined');
    // 40 successes push mu toward 1, >= 0.4 away from theta0 = 0.5 — but *above* the baseline, so
    // the quarantine gate (which is downward-only) must not fire. Symmetric drift used to bury the
    // most reliable rules in the store at ~16 consecutive successes.
    expect(statusFrom(many, trustOf(many, now))).not.toBe('quarantined');
    expect(many.status).not.toBe('quarantined');
    // The report stays symmetric: it is still "this far from the baseline", sign included.
    expect(isDrifting(many.ema.mu, many.ema.theta0, many.evidence.n)).toBe(true);
    expect(trustOf(many, now).trust).toBeGreaterThan(0);
  });

  test('sustained failure still quarantines: the gate is one-sided, not absent', () => {
    const now = T0 + 100_000;
    let state = freshState(KEY, T0, { guard: { kind: 'ci', lastOk: true, lastOkAt: T0 } });
    for (let i = 0; i < 6; i++) {
      state = applySignal(state, { spec: REJECT_RULE }, { now: T0 + i * 1000 }).state;
    }
    // mu has fallen well below the 0.5 baseline -> quarantined, T = 0.
    expect(isDriftingDown(state.ema.mu, state.ema.theta0, state.evidence.n)).toBe(true);
    expect(statusFrom(state, trustOf(state, now))).toBe('quarantined');
    expect(trustOf(state, now).trust).toBe(0);
  });

  test('a rejection does not refresh recency, preserving trust monotonicity for stale entities', () => {
    const state = guarded(0.9, 20);
    const later = T0 + 300 * DAY_MS;
    const before = trustOf(state, later).trust;
    const rejected = applySignal(state, { spec: REJECT_RULE }, { now: later }).state;
    const after = trustOf(rejected, later).trust;
    // Evidence got worse (20/21 < 20/20) and recency is not reset, so trust monotonically decreases.
    expect(wilsonLowerBound(20, 21)).toBeLessThan(wilsonLowerBound(20, 20));
    expect(after).toBeLessThanOrEqual(before);
  });
});
