import { InvalidArgumentError } from './errors.ts';

/**
 * Guard verification state, model §4.1.
 *
 * The host runs the guard; Sage only stores the result. `kind` is an open string for a
 * host-declared oracle; `lastOk` is `null` before the first report. A guard failure with
 * `guardKind === 'none'` is impossible — `none` means "no guard".
 */

/** Open string; `''` or `'none'` means unguarded. */
export type GuardKind = string;

export interface GuardState {
  readonly kind: GuardKind;
  /** `true` passed on last report, `false` failed, `null` never reported. */
  readonly lastOk: boolean | null;
  /** Epoch of the last report; `null` if never reported. */
  readonly lastOkAt: number | null;
}

/** Guard absent or explicitly `none`. */
export function isUnguarded(guard: GuardState): boolean {
  return guard.kind === 'none' || guard.kind === '';
}

/**
 * Guard multiplier G_i from the model §4.1 table:
 *   1.0 passed, 0.8 exists but unverified, 0.5 none, 0.0 failed.
 */
export function guardFactor(guard: GuardState): number {
  if (isUnguarded(guard)) return 0.5;
  if (guard.lastOk === false) return 0;
  if (guard.lastOk === true) return 1;
  return 0.8;
}

/** Guard already reported a failure — must never surface in ranking. */
export function guardFailed(guard: GuardState): boolean {
  return guard.kind !== 'none' && guard.lastOk === false;
}

export function newGuard(kind: GuardKind = 'none'): GuardState {
  if (typeof kind !== 'string' || kind.trim() === '') {
    throw new InvalidArgumentError('guard kind', 'a non-empty string', kind);
  }
  return { kind, lastOk: null, lastOkAt: null };
}
