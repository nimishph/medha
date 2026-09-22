import { InvalidArgumentError } from './errors.ts';

/**
 * Deterministic seeded PRNG for operations the kernel must replay (exploration helper §6.3).
 *
 * Time and randomness are never read ambiently (`Context` carries the seed), so a replay of the
 * same episodes + context is byte-identical. `mulberry32` is a 32-bit PRNG with a small state and
 * a uniform [0, 1) output, chosen for reproducibility across platforms and engines.
 */

export type SeededRng = () => number;

/** A byte-identical `mulberry32` seeded PRNG producing floats in [0, 1). */
export function mulberry32(seed: number): SeededRng {
  if (!Number.isInteger(seed) || seed < 0) {
    throw new InvalidArgumentError('seed', 'a non-negative integer', seed);
  }
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
