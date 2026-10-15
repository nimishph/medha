use medha_core::thresholds::MIN_USES_FOR_RETIRED;
use medha_core::types::{
    EmaState, Evidence, GuardState, LifecycleStatus, RecencyConfig, Thresholds,
};
use medha_core::{compute_trust_and_status, TrustComputationInput};

fn status_for(k: f64, n: f64, mu: f64) -> LifecycleStatus {
    let evidence = Evidence {
        k,
        n,
        context_rejects: 0,
    };
    let guard = GuardState {
        kind: "oracle".to_string(),
        last_ok: Some(true),
        last_ok_at: Some(1000),
    };
    let ema = EmaState {
        mu,
        theta0: 0.5,
        updated_at: 0,
        sample_count: 0,
    };
    let thresholds = Thresholds::default();
    let recency_config = RecencyConfig::default();
    compute_trust_and_status(TrustComputationInput {
        evidence: &evidence,
        guard: &guard,
        distinct_anchor_count: 1,
        ema: &ema,
        last_signal_at: Some(1000),
        now: 1000,
        stored_status: LifecycleStatus::Probation,
        status_override: None,
        thresholds: &thresholds,
        recency_config: &recency_config,
        rejecting_authors: None,
    })
    .expect("trust computes")
    .status
}

const MIN_RETIRED: f64 = MIN_USES_FOR_RETIRED as f64;

/// Signal-value weighting makes `n` fractional. The integer minimums (`min_uses_for_retired`,
/// drift's minimum samples) must compare against the raw `n`, as the TypeScript kernel does:
/// 0.18 short of the minimum is not the minimum, so the rule has not yet earned a retirement, and
/// 2.5 trials are not the 3 drift needs.
#[test]
fn fractional_n_below_a_minimum_does_not_count_as_reaching_it() {
    assert_eq!(
        status_for(0.71, MIN_RETIRED - 0.18, 0.79),
        LifecycleStatus::Probation
    );
    assert_eq!(status_for(0.3, 2.5, 0.01), LifecycleStatus::Probation);
}

#[test]
fn fractional_n_at_or_above_a_minimum_does_count() {
    assert_eq!(status_for(0.0, MIN_RETIRED, 0.79), LifecycleStatus::Retired);
    assert_eq!(
        status_for(0.0, MIN_RETIRED + 0.4, 0.79),
        LifecycleStatus::Retired
    );
}
