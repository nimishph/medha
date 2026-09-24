import { driftDelta, isDrifting } from './ema.ts';
import type { EntityKey, EntityState, LifecycleStatus } from './entity.ts';
import { ACTIVE_THRESHOLD, TRUSTED_THRESHOLD } from './thresholds.ts';
import { statusFrom, type TrustComponents, trustOf } from './trust.ts';

/**
 * The read-plane record for one entity, library spec §5.4.
 *
 * `SageRoutingHint.recommendation` is intentionally absent: a recommendation reads as a command,
 * and Sage is a hinter, not a decider (model §1, §2). The consumer compares `trustScore` (or
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

/** Build a hint from a state and `now`. Pure; no I/O. Single trust computation per hint. */
export function buildHint(state: EntityState, now: number): EvidentialHint {
  const result = trustOf(state, now);
  const status = statusFrom(state, result);
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
      isDrifting: isDrifting(state.ema.mu, state.ema.theta0, state.evidence.n),
      driftDelta: driftDelta(state.ema.mu, state.ema.theta0),
    },
    status,
    ...(state.lastNote !== undefined ? { lastNote: state.lastNote } : {}),
    clearsThreshold: {
      trusted:
        result.trust >= TRUSTED_THRESHOLD && state.guard.lastOk === true && state.evidence.n >= 5,
      active: result.trust >= ACTIVE_THRESHOLD,
    },
  };
}
