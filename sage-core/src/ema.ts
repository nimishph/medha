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
 * Whether the entity is drifting: enough trials, and enough divergence from baseline
 * to rule out noise.
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
