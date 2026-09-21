import { round6 } from './rounding.ts';
import { DURABILITY_GAIN, DURABILITY_MAX, WEEK_MS } from './thresholds.ts';

/**
 * Durability D over generalised anchors, model §4.3 generalised per library spec §5.4.
 *
 * The model's `h` was "distinct git commit heads survived". The library generalises that to
 * distinct **anchor values** (git head, dataset version, model version, session, …). `h` is the
 * number of distinct anchor values seen on successful uses.
 *
 * When no anchors have been declared, a **calendar-week epoch** is used as the anchor value, so D
 * degrades gracefully instead of being anchored to nothing.
 */

/** Anchor kind, an open string (git head, dataset version, session, …). */
export type AnchorKind = string;

/** One observed anchor value. */
export interface Anchor {
  readonly kind: AnchorKind;
  readonly value: string;
}

/** Distinct anchor values (a deduplicated set) seen on successful uses. */
export interface AnchorSet {
  /**
   * Whether these anchors are host-declared (`true`) or the calendar-week fallback (`false`).
   * The fallback guarantees the set is non-empty once any successful use exists.
   */
  readonly declared: boolean;
  readonly values: ReadonlySet<string>;
}

/** The unique values in an anchor list, per anchor kind. */
export function distinctAnchorValues(anchors: readonly Anchor[]): Set<string> {
  const seen = new Set<string>();
  for (const anchor of anchors) seen.add(`${anchor.kind}\u0000${anchor.value}`);
  return seen;
}

/**
 * The epoch (in weeks since the model's epoch) of a timestamp — the calendar-week fallback key.
 * Two timestamps in the same calendar week share an epoch.
 */
export function weekEpoch(at: number): number {
  return Math.floor(at / WEEK_MS);
}

/**
 * Build the anchor set an entity has survived for durability purposes.
 *
 * - Host-declared anchors, when at least one exists.
 * - Otherwise the calendar-week fallback: a synthetic anchor per distinct week epoch the entity
 *   has been alive across, geologged by the caller.
 */
export function anchorSetFor(
  anchors: readonly Anchor[],
  fallbackWeekEpochs: readonly number[] = [],
): AnchorSet {
  const declared = distinctAnchorValues(anchors);
  if (declared.size > 0) return { declared: true, values: declared };
  return {
    declared: false,
    values: new Set(fallbackWeekEpochs.map((epoch) => `week:${epoch}`)),
  };
}

/**
 * How many distinct anchors count toward durability. This is `h` in the model.
 * An empty (no declared, no fallback) set counts 0 — no survival credit yet.
 */
export function distinctSurvived(set: AnchorSet): number {
  return set.values.size;
}

/**
 * The durability multiplier. Empty survival → neutral 1.0; otherwise logarithmic growth to
 * DURABILITY_MAX (1.5).
 */
export function durabilityFactor(distinctSurvived: number): number {
  if (distinctSurvived <= 0) return 1;
  const bonus = 1 + DURABILITY_GAIN * Math.log1p(distinctSurvived);
  return round6(bonus > DURABILITY_MAX ? DURABILITY_MAX : bonus);
}
