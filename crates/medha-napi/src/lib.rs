use medha_core::formula::{compute_trust_and_status as core_compute_trust, TrustComputationInput};
use medha_core::types::{
    EmaState, Evidence, GuardState, LifecycleStatus, RecencyConfig, Thresholds,
};
use napi_derive::napi;

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiDriftReport {
    pub is_drifting: bool,
    pub is_drifting_down: bool,
    pub drift_delta: f64,
    pub drift_down_delta: f64,
    pub direction: Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiTrustScoreBreakdown {
    pub score: f64,
    pub wilson_lower: f64,
    pub wilson_upper: f64,
    pub recency: f64,
    pub durability: f64,
    pub guard_factor: f64,
    pub effective_ceiling: f64,
    pub is_drifting: bool,
    pub drift_direction: Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiTrustComputationResult {
    pub trust: f64,
    pub status: String,
    pub breakdown: NapiTrustScoreBreakdown,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiEvidence {
    pub k: f64,
    pub n: f64,
    pub context_rejects: u32,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiGuardState {
    pub kind: String,
    pub last_ok: Option<bool>,
    pub last_ok_at: Option<i64>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiEmaState {
    pub mu: f64,
    pub theta0: f64,
    pub sample_count: u32,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiThresholds {
    pub trusted: Option<f64>,
    pub min_uses_for_trusted: Option<u32>,
    pub active: Option<f64>,
    pub unguarded_ceiling: Option<f64>,
    pub min_uses_for_retired: Option<u32>,
    pub retired_trust_threshold: Option<f64>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiRecencyConfig {
    pub half_life_days: Option<f64>,
    pub floor: Option<f64>,
}

#[napi]
pub fn round6(val: f64) -> napi::Result<f64> {
    medha_core::round6(val).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn wilson_lower_bound(successes: f64, trials: f64, z: Option<f64>) -> napi::Result<f64> {
    let z_val = z.unwrap_or(medha_core::thresholds::WILSON_Z);
    medha_core::wilson_lower_bound(successes, trials, z_val)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn wilson_upper_bound(successes: f64, trials: f64, z: Option<f64>) -> napi::Result<f64> {
    let z_val = z.unwrap_or(medha_core::thresholds::WILSON_Z);
    medha_core::wilson_upper_bound(successes, trials, z_val)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn recency_factor(
    last_signal_at: Option<i64>,
    now: i64,
    half_life_days: Option<f64>,
    floor: Option<f64>,
) -> napi::Result<f64> {
    let mut config = RecencyConfig::default();
    if let Some(hl) = half_life_days {
        config.half_life_days = hl;
    }
    if let Some(fl) = floor {
        config.floor = fl;
    }
    medha_core::recency_factor(last_signal_at, now, &config)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn durability_factor(distinct_anchor_count: u32, is_guarded: bool) -> napi::Result<f64> {
    medha_core::durability_factor(distinct_anchor_count as usize, is_guarded)
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn guard_factor(kind: String, last_ok: Option<bool>) -> f64 {
    let state = GuardState {
        kind,
        last_ok,
        last_ok_at: None,
    };
    medha_core::guard_factor(&state)
}

#[napi]
pub fn ema_step(mu: Option<f64>, signal: f64, alpha: Option<f64>) -> napi::Result<f64> {
    let alpha_val = alpha.unwrap_or(medha_core::thresholds::DEFAULT_EMA_ALPHA);
    medha_core::ema_step(mu, signal, alpha_val).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn compute_drift(trials: u32, mu: f64, theta0: f64) -> napi::Result<NapiDriftReport> {
    let rep = medha_core::compute_drift(trials as u64, mu, theta0)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(NapiDriftReport {
        is_drifting: rep.is_drifting,
        is_drifting_down: rep.is_drifting_down,
        drift_delta: rep.drift_delta,
        drift_down_delta: rep.drift_down_delta,
        direction: rep.direction,
    })
}

#[napi]
#[allow(clippy::too_many_arguments)]
pub fn compute_trust_and_status(
    evidence: NapiEvidence,
    guard: NapiGuardState,
    distinct_anchor_count: u32,
    ema: NapiEmaState,
    last_signal_at: Option<i64>,
    now: i64,
    stored_status: Option<String>,
    status_override: Option<String>,
    thresholds: Option<NapiThresholds>,
    recency_config: Option<NapiRecencyConfig>,
) -> napi::Result<NapiTrustComputationResult> {
    let ev = Evidence {
        k: evidence.k,
        n: evidence.n,
        context_rejects: evidence.context_rejects as u64,
    };

    let gs = GuardState {
        kind: guard.kind,
        last_ok: guard.last_ok,
        last_ok_at: guard.last_ok_at,
    };

    let es = EmaState {
        mu: ema.mu,
        theta0: ema.theta0,
        sample_count: ema.sample_count as u64,
    };

    let parse_status = |s: &str| match s.to_lowercase().as_str() {
        "active" => LifecycleStatus::Active,
        "trusted" => LifecycleStatus::Trusted,
        "quarantined" => LifecycleStatus::Quarantined,
        "retired" => LifecycleStatus::Retired,
        _ => LifecycleStatus::Probation,
    };

    let st_status = stored_status
        .map(|s| parse_status(&s))
        .unwrap_or(LifecycleStatus::Probation);
    let st_override = status_override.map(|s| parse_status(&s));

    let mut th = Thresholds::default();
    if let Some(t) = thresholds {
        if let Some(tr) = t.trusted {
            th.trusted = tr;
        }
        if let Some(mu) = t.min_uses_for_trusted {
            th.min_uses_for_trusted = mu as u64;
        }
        if let Some(ac) = t.active {
            th.active = ac;
        }
        if let Some(uc) = t.unguarded_ceiling {
            th.unguarded_ceiling = uc;
        }
        if let Some(mr) = t.min_uses_for_retired {
            th.min_uses_for_retired = mr as u64;
        }
        if let Some(rt) = t.retired_trust_threshold {
            th.retired_trust_threshold = rt;
        }
    }

    let mut rc = RecencyConfig::default();
    if let Some(r) = recency_config {
        if let Some(hl) = r.half_life_days {
            rc.half_life_days = hl;
        }
        if let Some(fl) = r.floor {
            rc.floor = fl;
        }
    }

    let res = core_compute_trust(TrustComputationInput {
        evidence: &ev,
        guard: &gs,
        distinct_anchor_count: distinct_anchor_count as usize,
        ema: &es,
        last_signal_at,
        now,
        stored_status: st_status,
        status_override: st_override,
        thresholds: &th,
        recency_config: &rc,
    })
    .map_err(|e| napi::Error::from_reason(e.to_string()))?;

    let status_str = match res.status {
        LifecycleStatus::Probation => "probation",
        LifecycleStatus::Active => "active",
        LifecycleStatus::Trusted => "trusted",
        LifecycleStatus::Quarantined => "quarantined",
        LifecycleStatus::Retired => "retired",
    }
    .to_string();

    Ok(NapiTrustComputationResult {
        trust: res.trust,
        status: status_str,
        breakdown: NapiTrustScoreBreakdown {
            score: res.breakdown.score,
            wilson_lower: res.breakdown.wilson_lower,
            wilson_upper: res.breakdown.wilson_upper,
            recency: res.breakdown.recency,
            durability: res.breakdown.durability,
            guard_factor: res.breakdown.guard_factor,
            effective_ceiling: res.breakdown.effective_ceiling,
            is_drifting: res.breakdown.is_drifting,
            drift_direction: res.breakdown.drift_direction,
        },
    })
}
