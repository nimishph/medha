use crate::round::round6;
use crate::thresholds::DAY_MS;
use crate::types::{CoreError, RecencyConfig};
use std::f64::consts::LN_2;

/// Recency factor R according to docs/spec/trust-formula.md §4.3.
pub fn recency_factor(
    last_signal_at: Option<i64>,
    now: i64,
    config: &RecencyConfig,
) -> Result<f64, CoreError> {
    let floor = config.floor;
    let half_life_days = config.half_life_days;

    let Some(last_at) = last_signal_at else {
        return round6(floor);
    };

    let diff = (now - last_at) as f64;
    let age_days = (diff / DAY_MS).max(0.0);
    let decay = (-LN_2 * age_days / half_life_days).exp();
    let clamped = decay.max(floor).min(1.0);
    round6(clamped)
}
