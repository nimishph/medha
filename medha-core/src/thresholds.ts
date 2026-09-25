/**
 * Canonical parameters from MEDHA-MATHEMATICAL-MODEL.md §9.
 *
 * The kernel reads model parameters only from this module; nothing else declares a number that
 * shapes trust. These are the "code identifiers" of the model's canonical table.
 */

/** Normal distribution quantile, 95% confidence. */
export const WILSON_Z = 1.96;

/** Minimum trials before `trusted` is reachable regardless of the score. */
export const MIN_USES_FOR_TRUSTED = 5;

/** Trust at or above this may become `trusted`, with guard 1.0 and enough uses. */
export const TRUSTED_THRESHOLD = 0.6;

/** Trust at or above this may become `active`. */
export const ACTIVE_THRESHOLD = 0.25;

/** Hard ceiling on the trust of an unguarded entity (Invariant IV). */
export const UNGUARDED_TRUST_CEILING = 0.5;

/** Neutral skip signal value; damps the EMA without touching trial counts. */
export const SKIP_SIGNAL = 0.0;

/** Recency decay half-life in days. */
export const RECENCY_HALF_LIFE_DAYS = 45;

/** Recency retention floor protecting rare-but-valid memories. */
export const RECENCY_FLOOR = 0.3;

/** Durability logarithmic gain per additional distinct anchor. */
export const DURABILITY_GAIN = 0.15;

/** Durability multiplier ceiling. */
export const DURABILITY_MAX = 1.5;

/** Default EMA smoothing parameter. */
export const DEFAULT_EMA_ALPHA = 0.1;

/** Minimum trials before drift is detectable. */
export const MIN_SAMPLES_FOR_DRIFT = 3;

/** |mu - theta0| at or above this flags an entity as drifting. */
export const DRIFT_THRESHOLD = 0.4;

/** Default author-declared baseline prior for a fresh entity. */
export const DEFAULT_THETA0 = 0.5;

/** Trust below this retires an entity (equivalently, the floor before quarantine). */
export const RETIRED_TRUST_THRESHOLD = 0.1;

/** Minimum trials before an entity can be retired by trust (requires repeated evidence of failure). */
export const MIN_USES_FOR_RETIRED = 3;

/** Milliseconds in one sidereal-ish week (7 days). Used for the anchor fallback epoch. */
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Milliseconds in one day. */
export const DAY_MS = 24 * 60 * 60 * 1000;
