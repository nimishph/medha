/**
 * Deterministic rounding.
 *
 * Every number that leaves the kernel is rounded to a fixed number of decimal places so that two
 * replicas and two platforms agree bit-for-bit. IEEE-754 math is identical across macOS/Linux/Windows;
 * the risk is a consumer re-deriving and formatting an intermediate. Rounding at each output boundary
 * makes results independent of how far an intermediate was carried and of the consumer's own float
 * arithmetic.
 */

import { InvalidArgumentError } from './errors.ts';

/** Decimal places the kernel rounds to (PRD NFR: 6 decimals). */
export const ROUNDING_PLACES = 6;

/** Round a value to `ROUNDING_PLACES` using round-half-away-from-zero. */
export function round6(value: number): number {
  if (Number.isNaN(value) || !Number.isFinite(value)) {
    throw new InvalidArgumentError('value', 'a finite number', value);
  }
  const factor = 10 ** ROUNDING_PLACES;
  const shifted = Math.abs(value) * factor;
  const rounded = Math.trunc(shifted) + (shifted - Math.trunc(shifted) >= 0.5 ? 1 : 0);
  return (value < 0 ? -rounded : rounded) / factor;
}
