pub const TRUST_SPEC_VERSION: &str = "1.5.0";

/// Normal distribution quantile, 95% confidence.
pub const WILSON_Z: f64 = 1.96;

/// Minimum trials before `trusted` is reachable regardless of the score.
pub const MIN_USES_FOR_TRUSTED: u64 = 5;

/// Trust at or above this may become `trusted`, with guard 1.0 and enough uses.
pub const TRUSTED_THRESHOLD: f64 = 0.6;

/// Trust at or above this may become `active`.
pub const ACTIVE_THRESHOLD: f64 = 0.25;

/// Hard ceiling on the trust of an unguarded entity (Invariant IV).
pub const UNGUARDED_TRUST_CEILING: f64 = 0.5;

/// Neutral skip signal value; damps the EMA without touching trial counts.
pub const SKIP_SIGNAL: f64 = 0.0;

/// Recency decay half-life in days.
pub const RECENCY_HALF_LIFE_DAYS: f64 = 45.0;

/// Recency retention floor protecting rare-but-valid memories.
pub const RECENCY_FLOOR: f64 = 0.3;

/// Durability logarithmic gain per additional distinct anchor.
pub const DURABILITY_GAIN: f64 = 0.15;

/// Durability multiplier ceiling.
pub const DURABILITY_MAX: f64 = 1.5;

/// Default EMA smoothing parameter.
pub const DEFAULT_EMA_ALPHA: f64 = 0.1;

/// Minimum trials before drift is detectable.
pub const MIN_SAMPLES_FOR_DRIFT: u64 = 3;

/// |mu - theta0| at or above this flags an entity as drifting.
pub const DRIFT_THRESHOLD: f64 = 0.4;

/// Default author-declared baseline prior for a fresh entity.
pub const DEFAULT_THETA0: f64 = 0.5;

/// Trust below this retires an entity.
pub const RETIRED_TRUST_THRESHOLD: f64 = 0.1;

/// Minimum trials before an entity can be retired by trust.
pub const MIN_USES_FOR_RETIRED: u64 = 3;

/// Milliseconds in one day.
pub const DAY_MS: f64 = 86_400_000.0;

/// Milliseconds in one week (7 days).
pub const WEEK_MS: f64 = 7.0 * DAY_MS;
