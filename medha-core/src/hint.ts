import { driftDelta } from './ema.ts';
import type { EntityKey, EntityState, LifecycleStatus } from './entity.ts';
import type { KindSpec } from './kinds.ts';
import {
  ACTIVE_THRESHOLD,
  DRIFT_THRESHOLD,
  MIN_SAMPLES_FOR_DRIFT,
  MIN_USES_FOR_TRUSTED,
  TRUSTED_THRESHOLD,
} from './thresholds.ts';
import { statusFrom, type TrustComponents, trustOf } from './trust.ts';

/**
 * The read-plane record for one entity, library spec §5.4.
 *
 * `EvidentialHint.recommendation` is intentionally absent: a recommendation reads as a command,
 * and Medha is a hinter, not a decider (model §1, §2). The consumer compares `trustScore` (or
 * `clearsThreshold`) against its own break-even.
 */

export interface EvidentialHint {
  readonly key: EntityKey;
  readonly asOf: number;
  /** T in [0,1]. */
  readonly trustScore: number;
  readonly components: TrustComponents;
  readonly evidence: {
    readonly successes: number;
    readonly totalTrials: number;
    readonly lowerBound: number;
  };
  readonly temporal: {
    readonly emaWeight: number;
    readonly isDrifting: boolean;
    readonly driftDelta: number;
  };
  readonly status: LifecycleStatus;
  /** Natural language rationale or note from the latest episode (if any). */
  readonly lastNote?: string | undefined;
  readonly clearsThreshold: {
    readonly trusted: boolean;
    readonly active: boolean;
  };
}

/** One named check inside a gate; `actual`/`expected` are null for boolean checks. */
export interface GateCondition {
  readonly name: 'trust' | 'uses' | 'guard' | 'samples' | 'drift';
  readonly met: boolean;
  readonly actual: number | boolean;
  readonly expected: number | boolean;
}

export interface Gate {
  readonly name: 'trusted' | 'active' | 'drifting';
  readonly met: boolean;
  readonly threshold: number;
  readonly value: number;
  readonly conditions: readonly GateCondition[];
}

/**
 * The single definition of the trusted/active/drifting gates. `buildHint().clearsThreshold` and
 * `explain-threshold` both derive from this, so they cannot disagree; a gate is met exactly when
 * every one of its conditions is.
 */
export function evaluateGates(
  state: EntityState,
  trust: number,
  kindSpec?: KindSpec,
): readonly [Gate, Gate, Gate] {
  const trustedThreshold = kindSpec?.thresholds?.trusted ?? TRUSTED_THRESHOLD;
  const minUsesForTrusted = kindSpec?.thresholds?.minUsesForTrusted ?? MIN_USES_FOR_TRUSTED;
  const activeThreshold = kindSpec?.thresholds?.active ?? ACTIVE_THRESHOLD;
  const n = state.evidence.n;
  const delta = driftDelta(state.ema.mu, state.ema.theta0);
  const gate = (
    name: Gate['name'],
    threshold: number,
    value: number,
    conditions: readonly GateCondition[],
  ): Gate => ({ name, met: conditions.every((c) => c.met), threshold, value, conditions });
  return [
    gate('trusted', trustedThreshold, trust, [
      { name: 'trust', met: trust >= trustedThreshold, actual: trust, expected: trustedThreshold },
      { name: 'uses', met: n >= minUsesForTrusted, actual: n, expected: minUsesForTrusted },
      {
        name: 'guard',
        met: state.guard.lastOk === true,
        actual: state.guard.lastOk === true,
        expected: true,
      },
    ]),
    gate('active', activeThreshold, trust, [
      { name: 'trust', met: trust >= activeThreshold, actual: trust, expected: activeThreshold },
    ]),
    gate('drifting', DRIFT_THRESHOLD, delta, [
      {
        name: 'samples',
        met: n >= MIN_SAMPLES_FOR_DRIFT,
        actual: n,
        expected: MIN_SAMPLES_FOR_DRIFT,
      },
      { name: 'drift', met: delta >= DRIFT_THRESHOLD, actual: delta, expected: DRIFT_THRESHOLD },
    ]),
  ];
}

/** Build a hint from a state and `now`. Pure; no I/O. Single trust computation per hint. */
export function buildHint(state: EntityState, now: number, kindSpec?: KindSpec): EvidentialHint {
  const result = trustOf(state, now, kindSpec);
  const status = statusFrom(state, result, kindSpec);
  const [trusted, active, drifting] = evaluateGates(state, result.trust, kindSpec);
  return {
    key: state.key,
    asOf: now,
    trustScore: result.trust,
    components: result.components,
    evidence: {
      successes: state.evidence.k,
      totalTrials: state.evidence.n,
      lowerBound: result.components.wilson,
    },
    temporal: {
      emaWeight: state.ema.mu,
      isDrifting: drifting.met,
      driftDelta: drifting.value,
    },
    status,
    ...(state.lastNote !== undefined ? { lastNote: state.lastNote } : {}),
    clearsThreshold: { trusted: trusted.met, active: active.met },
  };
}
