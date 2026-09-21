import { InvalidArgumentError } from './errors.ts';

/**
 * The `context` every operation takes. Time and randomness are never read ambiently — they arrive
 * here, so a replay of the same episodes + context is byte-identical (kernel determinism property).
 */
export interface Context {
  /** Epoch (ms) the operation is `as of`. */
  readonly now: number;
  /** Seeded RNG source for operations that need one (exploration). `undefined` = none needed. */
  readonly seed?: number;
}

/** Validate a context: `now` must be a positive finite epoch and, when present, seed a safe int. */
export function sanitizeContext(context: Context): void {
  if (typeof context.now !== 'number' || !Number.isFinite(context.now) || context.now < 0) {
    throw new InvalidArgumentError('context.now', 'a finite epoch >= 0', context.now);
  }
  if (context.seed !== undefined && (!Number.isInteger(context.seed) || context.seed < 0)) {
    throw new InvalidArgumentError('context.seed', 'a non-negative integer', context.seed);
  }
}
