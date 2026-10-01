use crate::round::round6;
use crate::thresholds::{DURABILITY_GAIN, DURABILITY_MAX};
use crate::types::CoreError;

/// Durability factor D according to docs/spec/trust-formula.md §4.4.
pub fn durability_factor(distinct_anchor_count: usize, is_guarded: bool) -> Result<f64, CoreError> {
    if !is_guarded || distinct_anchor_count == 0 {
        return Ok(1.0);
    }
    let h = distinct_anchor_count as f64;
    let d = 1.0 + DURABILITY_GAIN * (1.0 + h).ln();
    let capped = d.min(DURABILITY_MAX);
    round6(capped)
}

/// Raw durability without guard gating (used for vector verification).
pub fn raw_durability_factor(h: usize) -> Result<f64, CoreError> {
    if h == 0 {
        return Ok(1.0);
    }
    let h_f64 = h as f64;
    let d = 1.0 + DURABILITY_GAIN * (1.0 + h_f64).ln();
    let capped = d.min(DURABILITY_MAX);
    round6(capped)
}
