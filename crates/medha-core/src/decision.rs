use crate::formula::compute_trust_and_status;
use crate::types::{
    CoreError, EmaState, Evidence, GuardState, LifecycleStatus, RecencyConfig, Thresholds,
    TrustScoreBreakdown,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Decision {
    Apply,
    Ignore,
    Probability { value: f64 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecisionCase {
    pub id: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    pub condition: String,
    pub decision: Decision,
    pub evidence: Evidence,
    pub ema: EmaState,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScoredDecisionCase {
    #[serde(flatten)]
    pub kase: DecisionCase,
    pub trust: f64,
    pub status: LifecycleStatus,
    pub breakdown: TrustScoreBreakdown,
}

pub fn is_human_author(author: Option<&str>) -> bool {
    author.map(|a| a.starts_with("human:")).unwrap_or(false)
}

/// A branch has a synthetic "passed" guard so the unguarded ceiling never restricts it.
fn branch_guard() -> GuardState {
    GuardState {
        kind: "branch".to_string(),
        last_ok: Some(true),
        last_ok_at: None,
    }
}

pub fn score_decision_case(
    kase: &DecisionCase,
    now: i64,
    thresholds: &Thresholds,
    recency_config: &RecencyConfig,
) -> Result<ScoredDecisionCase, CoreError> {
    let guard = branch_guard();
    let res = compute_trust_and_status(crate::formula::TrustComputationInput {
        evidence: &kase.evidence,
        guard: &guard,
        distinct_anchor_count: 0,
        ema: &kase.ema,
        last_signal_at: None,
        now,
        stored_status: LifecycleStatus::Probation,
        status_override: None,
        thresholds,
        recency_config,
    })?;

    Ok(ScoredDecisionCase {
        kase: kase.clone(),
        trust: res.trust,
        status: res.status,
        breakdown: res.breakdown,
    })
}
