import { type Anchor, anchorSetFor, distinctSurvived, durabilityFactor } from './durability.ts';
import { isDrifting } from './ema.ts';
import type { EntityState, Evidence, LifecycleStatus } from './entity.ts';
import { type GuardState, guardFactor, guardFailed, isUnguarded } from './guard.ts';
import type { KindSpec } from './kinds.ts';
import { recencyDecay } from './recency.ts';
import { round6 } from './rounding.ts';
import {
  ACTIVE_THRESHOLD,
  MIN_USES_FOR_RETIRED,
  MIN_USES_FOR_TRUSTED,
  RETIRED_TRUST_THRESHOLD,
  TRUSTED_THRESHOLD,
  UNGUARDED_TRUST_CEILING,
} from './thresholds.ts';
import { wilsonLowerBound } from './wilson.ts';

/**
 * The unified trust score and lifecycle, model §5 and library spec §5.1/§5.3.
 *
 *     T = min( C_unguarded, L(k,n) · G · R(Δt) · D(h) )
 *
 * - L is the Wilson lower bound (the evidence count, never the raw ratio).
 * - G is the guard multiplier (§4.1); G = 0 zeroes T and quarantines.
 * - R is the recency decay (§4.2), floored at 0.30.
 * - D is the durability over generalised anchors (§4.3, generalised in §5.4): distinct anchor
 *   values survived, with a calendar-week fallback when the host declares none.
 * - C_unguarded = 0.50 clamps unguarded entities (Invariant IV); durability is neutral (1.0) for
 *   unguarded entities because no guard ever verified anything (§4.3 invariant).
 */

export interface TrustComponents {
  readonly wilson: number;
  readonly guard: number;
  readonly recency: number;
  readonly durability: number;
  readonly ceiling: number;
}

export interface TrustResult {
  readonly trust: number;
  readonly components: TrustComponents;
  readonly unguarded: boolean;
}

/** Guarded entities can keep all of [0,1]; unguarded ones hit Invariant IV's ceiling. */
export function ceilingFor(unguarded: boolean, customCeiling?: number): number {
  return unguarded ? (customCeiling ?? UNGUARDED_TRUST_CEILING) : 1;
}

const CEILING_GUARDED = 1;

/** Clamp T into [0,1] (the hint's contract) and to 6 decimals. */
function clampTrust(value: number): number {
  return round6(value < 0 ? 0 : value > 1 ? 1 : value);
}

/**
 * The pure, cell-by-cell composition step of §5, model §7:
 *     T = min( ceiling, L · G · R · D ),  clamped to [0,1] and to 6 decimals.
 * Exposed so the composition itself — the model §7 worked example included — is unit-testable
 * without contorting a real evidence/guard/anchor profile.
 */
export function composeTrust(
  l: number,
  g: number,
  r: number,
  d: number,
  ceiling: number = CEILING_GUARDED,
): number {
  const raw = l * g * r * d;
  return clampTrust(raw > ceiling ? ceiling : raw);
}

/**
 * Durability `h` for an entity: distinct host-declared anchor values, else the calendar-week
 * fallback over the timestamps supplied (normally its success history) as distinct week epochs.
 */
export function survivedCount(
  anchors: readonly Anchor[],
  fallbackTimestamps: readonly number[],
): number {
  const probe = anchorSetFor(anchors, fallbackTimestamps);
  return distinctSurvived(probe);
}

export function computeTrust(
  evidence: Evidence,
  guardState: GuardState,
  anchors: readonly Anchor[],
  lastUsedAt: number | null,
  now: number,
  kindSpec?: KindSpec,
): TrustResult {
  const unguarded = isUnguarded(guardState);
  const guardValue = guardFactor(guardState);

  // G = 0 (failed) and unguarded (G = 0.5) both resolve here; the ceiling differs.
  const wilsonValue = wilsonLowerBound(evidence.k, evidence.n);
  const recency = recencyDecay(lastUsedAt, now, kindSpec?.recency);
  const ceiling = ceilingFor(unguarded, kindSpec?.thresholds?.unguardedCeiling);

  // Unguarded entities get neutral durability (nothing was ever checked, §4.3 invariant).
  const durability = unguarded ? 1 : durabilityFromAnchors(anchors, lastUsedAt);

  let trust = composeTrust(wilsonValue, guardValue, recency, durability, ceiling);
  // Unguarded entities must never reach ceiling — they stay strictly under the cap even when radical
  // rounding would push them onto it, so they can never be confused with a guarded half-cap.
  if (unguarded && trust >= ceiling) trust = round6(ceiling - 1e-6);

  return {
    trust,
    components: { wilson: wilsonValue, guard: guardValue, recency, durability, ceiling },
    unguarded,
  };
}

function durabilityFromAnchors(
  anchors: readonly Anchor[],
  fallbackEpochTime: number | null,
): number {
  const fallback: number[] = [];
  if (fallbackEpochTime !== null) fallback.push(fallbackEpochTime);
  return durabilityFactor(survivedCount(anchors, fallback));
}

/** The trust of an entity. Quarantined and retired entities score 0 — they must never surface. */
export function trustOf(state: EntityState, now: number, kindSpec?: KindSpec): TrustResult {
  if (state.status === 'quarantined' || state.status === 'retired') {
    const wilson = wilsonLowerBound(state.evidence.k, state.evidence.n);
    const guard = guardFactor(state.guard);
    return {
      trust: 0,
      components: {
        wilson,
        guard,
        recency: recencyDecay(state.lastSignalAt, now, kindSpec?.recency),
        durability: 1,
        ceiling: ceilingFor(isUnguarded(state.guard), kindSpec?.thresholds?.unguardedCeiling),
      },
      unguarded: isUnguarded(state.guard),
    };
  }
  return computeTrust(
    state.evidence,
    state.guard,
    state.anchors,
    state.lastSignalAt,
    now,
    kindSpec,
  );
}

/**
 * The status the trust level justifies, independent of the stored one (the trust is already
 * computed — `statusFor` and the hint builder share this tail to avoid double work).
 */
export function statusForTrust(
  state: EntityState,
  trust: TrustResult,
  kindSpec?: KindSpec,
): LifecycleStatus {
  // Retirement requires repeated evidence of failure/rejection (n >= minUsesForRetired).
  // Undecayed performance (Wilson bound * guard) must fall below retiredTrustThreshold.
  // Age/recency decay alone must NEVER retire an entity — dormant or unproven entities sit on probation.
  const minUsesForRetired = kindSpec?.thresholds?.minUsesForRetired ?? MIN_USES_FOR_RETIRED;
  const retiredThreshold = kindSpec?.thresholds?.retiredTrustThreshold ?? RETIRED_TRUST_THRESHOLD;
  const undecayedTrust = trust.components.wilson * trust.components.guard;
  if (state.evidence.n >= minUsesForRetired && undecayedTrust < retiredThreshold) {
    return 'retired';
  }

  // Model §5.1: trusted requires T ≥ trustedThreshold AND n ≥ minUsesForTrusted AND G = 1.0 (the last guard passed).
  const trustedThreshold = kindSpec?.thresholds?.trusted ?? TRUSTED_THRESHOLD;
  const minUsesForTrusted = kindSpec?.thresholds?.minUsesForTrusted ?? MIN_USES_FOR_TRUSTED;
  if (
    trust.trust >= trustedThreshold &&
    state.evidence.n >= minUsesForTrusted &&
    state.guard.lastOk === true
  ) {
    return 'trusted';
  }

  const activeThreshold = kindSpec?.thresholds?.active ?? ACTIVE_THRESHOLD;
  if (trust.trust >= activeThreshold) return 'active';
  return 'probation';
}

/**
 * The status the numbers justify, independent of the stored one. Model §5.1 transitions:
 * probation → active → trusted; exits: quarantine (G=0 or drift) and retire (T < 0.10).
 * Drift is a pure function of the EMA state, so it belongs in the kernel: an entity whose
 * learned weight has moved ≥ 0.40 away from its author baseline cannot be trusted.
 *
 * `trust` is already computed by the caller (statusFor here, the hint builder when it holds the
 * same TrustResult) — this is the single-pass core shared by both, so a batch never pays for the
 * trust twice.
 */
export function statusFrom(
  state: EntityState,
  trust: TrustResult,
  kindSpec?: KindSpec,
): LifecycleStatus {
  // Explicit lifecycle overrides are terminal until restored — the host decided, numbers don't
  // overrule it (a stored retire also stays put for states built before overrides were tracked).
  if (state.override === 'retired') return 'retired';
  if (state.override === 'quarantined') return 'quarantined';
  if (state.status === 'retired') return 'retired';
  if (guardFailed(state.guard)) return 'quarantined';
  if (isDrifting(state.ema.mu, state.ema.theta0, state.evidence.n)) return 'quarantined';
  return statusForTrust(state, trust, kindSpec);
}

/** The status the numbers justify, independent of the stored one. */
export function statusFor(state: EntityState, now: number, kindSpec?: KindSpec): LifecycleStatus {
  return statusFrom(state, trustOf(state, now, kindSpec), kindSpec);
}
