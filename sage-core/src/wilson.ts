import { InvalidArgumentError } from './errors.ts';
import { round6 } from './rounding.ts';
import { WILSON_Z } from './thresholds.ts';

/**
 * Wilson score interval, model §3.1.
 *
 *     L(k, n, z) = [ p̂ + z²/2n - z·√(p̂(1-p̂)/n + z²/4n²) ] / (1 + z²/n)
 *
 * Chosen over the raw ratio because the ratio is maximally optimistic where evidence is weakest:
 * 1/1 scores ~0.21, far below a seasoned 38/40 (~0.87). Returns 0 for zero trials — no evidence
 * means no claim, not an optimistic prior.
 */

/** Validate the evidence counts shared by both bounds. Zero trials is valid (width = full). */
function validateCounts(successes: number, trials: number): void {
  if (!Number.isInteger(successes) || !Number.isInteger(trials) || successes < 0 || trials < 0) {
    throw new InvalidArgumentError('evidence counts', 'non-negative integers', {
      successes,
      trials,
    });
  }
  if (successes > trials) {
    throw new InvalidArgumentError('successes', `at most trials (${trials})`, successes);
  }
}

export function wilsonLowerBound(successes: number, trials: number, z: number = WILSON_Z): number {
  validateCounts(successes, trials);
  if (trials === 0) return 0;

  const p = successes / trials;
  const z2 = z * z;
  const centre = p + z2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  const denominator = 1 + z2 / trials;
  const lower = (centre - margin) / denominator;
  return round6(lower < 0 ? 0 : lower);
}

/**
 * The upper end of the same interval. The exploration helper weights plausibility by the width
 * `upper - lower`, so an entity is "more uncertain" the wider its interval; the maximum width is
 * reached as evidence disappears.
 */
export function wilsonUpperBound(successes: number, trials: number, z: number = WILSON_Z): number {
  validateCounts(successes, trials);
  if (trials === 0) return 0;

  const p = successes / trials;
  const z2 = z * z;
  const centre = p + z2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  const denominator = 1 + z2 / trials;
  const upper = (centre + margin) / denominator;
  return round6(upper > 1 ? 1 : upper);
}

/**
 * Width of the Wilson interval at the given confidence. Zero trials has width 1 — an unseen
 * entity is maximally uncertain, so the exploration helper tries it soonest.
 */
export function wilsonWidth(successes: number, trials: number, z: number = WILSON_Z): number {
  validateCounts(successes, trials);
  if (trials === 0) return 1;
  const width = wilsonUpperBound(successes, trials, z) - wilsonLowerBound(successes, trials, z);
  return round6(width < 0 ? 0 : width);
}
