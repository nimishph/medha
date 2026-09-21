import { InvalidArgumentError } from './errors.ts';
import { round6 } from './rounding.ts';
import { WILSON_Z } from './thresholds.ts';

/**
 * Wilson score interval lower bound, model §3.1.
 *
 *     L(k, n, z) = [ p̂ + z²/2n - z·√(p̂(1-p̂)/n + z²/4n²) ] / (1 + z²/n)
 *
 * Chosen over the raw ratio because the ratio is maximally optimistic where evidence is weakest:
 * 1/1 scores ~0.21, far below a seasoned 38/40 (~0.87). Returns 0 for zero trials — no evidence
 * means no claim, not an optimistic prior.
 */
export function wilsonLowerBound(successes: number, trials: number, z: number = WILSON_Z): number {
  if (!Number.isInteger(successes) || !Number.isInteger(trials) || successes < 0 || trials < 0) {
    throw new InvalidArgumentError('evidence counts', 'non-negative integers', {
      successes,
      trials,
    });
  }
  if (successes > trials) {
    throw new InvalidArgumentError('successes', `at most trials (${trials})`, successes);
  }
  if (trials === 0) return 0;

  const p = successes / trials;
  const z2 = z * z;
  const centre = p + z2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  const denominator = 1 + z2 / trials;
  const lower = (centre - margin) / denominator;
  return round6(lower < 0 ? 0 : lower);
}
