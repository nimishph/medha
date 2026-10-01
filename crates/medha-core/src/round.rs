use crate::types::CoreError;

pub const ROUNDING_PLACES: i32 = 6;

/// Round a value to 6 decimal places using round-half-away-from-zero on magnitude.
/// Conforms to docs/spec/trust-formula.md §1.1.
pub fn round6(value: f64) -> Result<f64, CoreError> {
    if !value.is_finite() {
        return Err(CoreError::NonFiniteNumber(value));
    }
    let factor = 10f64.powi(ROUNDING_PLACES);
    let shifted = value.abs() * factor;
    let trunc = shifted.trunc();
    let rounded = trunc + if (shifted - trunc) >= 0.5 { 1.0 } else { 0.0 };
    let signed = if value < 0.0 { -rounded } else { rounded };
    Ok(signed / factor)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_round6() {
        assert_eq!(round6(0.1234567).unwrap(), 0.123457);
        assert_eq!(round6(0.1234564).unwrap(), 0.123456);
        assert_eq!(round6(-0.1234565).unwrap(), -0.123457);
        assert_eq!(round6(0.0).unwrap(), 0.0);
    }
}
