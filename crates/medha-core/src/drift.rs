use crate::round::round6;
use crate::thresholds::{DRIFT_THRESHOLD, MIN_SAMPLES_FOR_DRIFT};
use crate::types::CoreError;

/// Step the Exponential Moving Average according to docs/spec/trust-formula.md §7:
/// emaStep(mu, s, alpha) = round6( clamp((mu ?? 0)(1−alpha) + alpha·s, 0, 1) )
pub fn ema_step(mu: Option<f64>, signal: f64, alpha: f64) -> Result<f64, CoreError> {
    let prev = mu.unwrap_or(0.0);
    let updated = prev * (1.0 - alpha) + alpha * signal;
    let clamped = updated.clamp(0.0, 1.0);
    round6(clamped)
}

#[derive(Debug, Clone, PartialEq)]
pub struct DriftReport {
    pub is_drifting: bool,
    pub is_drifting_down: bool,
    pub drift_delta: f64,
    pub drift_down_delta: f64,
    pub direction: Option<String>,
}

/// Compute drift predicates and deltas according to docs/spec/trust-formula.md §7.
pub fn compute_drift(trials: u64, mu: f64, theta0: f64) -> Result<DriftReport, CoreError> {
    let drift_delta = round6((mu - theta0).abs())?;
    let drift_down_delta = round6((theta0 - mu).max(0.0))?;

    let is_drifting = trials >= MIN_SAMPLES_FOR_DRIFT && drift_delta >= DRIFT_THRESHOLD;
    let is_drifting_down = trials >= MIN_SAMPLES_FOR_DRIFT && drift_down_delta >= DRIFT_THRESHOLD;

    let direction = if is_drifting {
        if mu > theta0 {
            Some("up".to_string())
        } else {
            Some("down".to_string())
        }
    } else {
        None
    };

    Ok(DriftReport {
        is_drifting,
        is_drifting_down,
        drift_delta,
        drift_down_delta,
        direction,
    })
}
