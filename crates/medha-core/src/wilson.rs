use crate::round::round6;
use crate::thresholds::WILSON_Z;
use crate::types::CoreError;

fn validate_counts(successes: f64, trials: f64) -> Result<(), CoreError> {
    if !successes.is_finite() || !trials.is_finite() || successes < 0.0 || trials < 0.0 {
        return Err(CoreError::InvalidCounts { successes, trials });
    }
    if successes > trials + 1e-9 {
        return Err(CoreError::InvalidCounts { successes, trials });
    }
    Ok(())
}

/// Wilson score lower bound L(k, n, z).
/// Returns 0.0 when trials == 0.0.
pub fn wilson_lower_bound(successes: f64, trials: f64, z: f64) -> Result<f64, CoreError> {
    validate_counts(successes, trials)?;
    if trials == 0.0 {
        return Ok(0.0);
    }
    let p = (successes / trials).clamp(0.0, 1.0);
    let z2 = z * z;
    let centre = p + z2 / (2.0 * trials);
    let variance = ((p * (1.0 - p)) / trials).max(0.0);
    let margin = z * (variance + z2 / (4.0 * trials * trials)).sqrt();
    let denominator = 1.0 + z2 / trials;
    let lower = (centre - margin) / denominator;
    round6(lower.max(0.0))
}

/// Wilson score upper bound U(k, n, z).
pub fn wilson_upper_bound(successes: f64, trials: f64, z: f64) -> Result<f64, CoreError> {
    validate_counts(successes, trials)?;
    if trials == 0.0 {
        return Ok(1.0);
    }
    let p = (successes / trials).clamp(0.0, 1.0);
    let z2 = z * z;
    let centre = p + z2 / (2.0 * trials);
    let variance = ((p * (1.0 - p)) / trials).max(0.0);
    let margin = z * (variance + z2 / (4.0 * trials * trials)).sqrt();
    let denominator = 1.0 + z2 / trials;
    let upper = (centre + margin) / denominator;
    round6(upper.min(1.0))
}

pub fn default_wilson_lower(successes: f64, trials: f64) -> Result<f64, CoreError> {
    wilson_lower_bound(successes, trials, WILSON_Z)
}

pub fn default_wilson_upper(successes: f64, trials: f64) -> Result<f64, CoreError> {
    wilson_upper_bound(successes, trials, WILSON_Z)
}
