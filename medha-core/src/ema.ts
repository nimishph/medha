import { InvalidArgumentError } from './errors.ts';
import { round6 } from './rounding.ts';
import { DEFAULT_EMA_ALPHA, DRIFT_THRESHOLD, MIN_SAMPLES_FOR_DRIFT } from './thresholds.ts';

/**
 * Exponential moving average — the temporal drift filter, model §3.2.
 *
 *     μ_{i,t} = α·s_t + (1-α)·μ_{i,t-1}
 *
 * μ lives in [0, 1]. A SKIP (s=0) simply decays the average toward zero without any trial being
 * recorded (model §3.3); a REJECT_RULE (s=-1) actively drives it down.
 */

export interface EmaParams {
  /** EMA smoothing parameter α in (0, 1]. */
  readonly alpha: number;
  /** Minimum trials before drift is a claim, not noise. */
  readonly minSamplesForDrift: number;
  /** |μ - θ0| at or above this counts as drifting. */
  readonly driftThreshold: number;
}

export const DEFAULT_EMA_PARAMS: EmaParams = {
  alpha: DEFAULT_EMA_ALPHA,
  minSamplesForDrift: MIN_SAMPLES_FOR_DRIFT,
  driftThreshold: DRIFT_THRESHOLD,
};

/** One EMA step. Clamped to [0,1] so rejection cannot spuriously overshoot. */
export function emaStep(
  mu: number | undefined,
  signal: number,
  alpha: number = DEFAULT_EMA_ALPHA,
): number {
  if (!Number.isFinite(signal)) {
    throw new InvalidArgumentError('signal', 'a finite number in [-1,1]', signal);
  }
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) {
    throw new InvalidArgumentError('alpha', 'a number in (0,1]', alpha);
  }
  const next = (mu ?? 0) * (1 - alpha) + alpha * signal;
  return round6(Math.min(1, Math.max(0, next)));
}

/** |μ - θ0| — divergence from the author baseline, model §3.4. */
export function driftDelta(mu: number, theta0: number): number {
  return round6(Math.abs(mu - theta0));
}

/**
 * How far μ has fallen *below* the author baseline, 0 when it is at or above it. One-sided on
 * purpose: falling behind the baseline is the hazard, out-performing it is not (see
 * `isDriftingDown`).
 */
export function driftDownDelta(mu: number, theta0: number): number {
  return round6(Math.max(0, theta0 - mu));
}

/**
 * Whether the entity is drifting in *either* direction: enough trials, and enough divergence from
 * baseline to rule out noise. This is the report — `medha drift`, the `drifting` gate, and
 * `temporal.isDrifting` all answer "how far has the learned weight moved from its baseline",
 * regardless of sign.
 *
 * It is deliberately NOT the quarantine predicate: an entity that only ever succeeds walks μ up to
 * 1 against the 0.5 default baseline and trips a symmetric 0.4 threshold after ~16 consecutive
 * successes, so using it to quarantine buries the most reliable rules in the store. Quarantine uses
 * `isDriftingDown` instead.
 */
export function isDrifting(
  mu: number,
  theta0: number,
  samples: number,
  params: EmaParams = DEFAULT_EMA_PARAMS,
): boolean {
  if (samples < params.minSamplesForDrift) return false;
  return driftDelta(mu, theta0) >= params.driftThreshold;
}

/**
 * Whether the entity has drifted far enough *downward* to be quarantined: enough trials, and μ at
 * or more than `driftThreshold` below the author baseline.
 *
 * Downward-only, because quarantine is a statement that an entity can no longer be trusted. μ
 * moving toward 0 is that statement; μ moving toward 1 says the opposite — the entity outperforms
 * the author's prior and has earned trust, not lost it. A symmetric test would make sustained
 * success a punishment, so ~16 straight APPLYs at the default α quarantine a flawless rule with
 * trust 0 and it stops surfacing entirely.
 */
export function isDriftingDown(
  mu: number,
  theta0: number,
  samples: number,
  params: EmaParams = DEFAULT_EMA_PARAMS,
): boolean {
  if (samples < params.minSamplesForDrift) return false;
  return driftDownDelta(mu, theta0) >= params.driftThreshold;
}
