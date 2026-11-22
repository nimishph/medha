use crate::decision::{
    is_human_author, score_decision_case, Decision, DecisionCase, ScoredDecisionCase,
};
use crate::fold::KindSpec;
use crate::types::{CoreError, EntityKey, Evidence, LifecycleStatus, RecencyConfig, Thresholds};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyLatchEntityState {
    pub status: LifecycleStatus,
    pub evidence: Evidence,
    /// The calibrated trust score (TS `trustOf(state, now, kindSpec).trust`). When absent, the
    /// default evaluation falls back to the raw success ratio `k / n`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust: Option<f64>,
}

impl PolicyLatchEntityState {
    pub fn new(status: LifecycleStatus, evidence: Evidence) -> Self {
        Self {
            status,
            evidence,
            trust: None,
        }
    }

    /// Attach the calibrated trust score used for the default evaluation and `minTrust` gate.
    pub fn with_trust(mut self, trust: f64) -> Self {
        self.trust = Some(trust);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyLatchInput {
    pub key: EntityKey,
    #[serde(default)]
    pub context: Option<serde_json::Value>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub action: Option<String>,
    #[serde(default)]
    pub min_trust: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyLatchRecommendation {
    Proceed,
    EscalateToHuman,
    Block,
    Skip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyLatchReason {
    Approved,
    StatusLatched,
    RequireHumanGate,
    BranchUntrusted,
    EntityUntrusted,
    DecisionIgnore,
    NoMatchingBranch,
    EntityNotFound,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyLatchOutcome {
    pub allowed: bool,
    pub latched: bool,
    pub requires_human: bool,
    pub recommendation: PolicyLatchRecommendation,
    pub reason: PolicyLatchReason,
    pub explanation: String,
    pub trust: f64,
    pub status: LifecycleStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_case: Option<ScoredDecisionCase>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision: Option<Decision>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub escalation_instructions: Option<String>,
}

pub fn match_condition(condition: &str, context: Option<&serde_json::Value>) -> bool {
    let norm_cond = condition.trim();
    if norm_cond.is_empty()
        || norm_cond == "*"
        || norm_cond.eq_ignore_ascii_case("always")
        || norm_cond.eq_ignore_ascii_case("true")
    {
        return true;
    }
    let ctx = match context {
        Some(c) => c,
        None => {
            return norm_cond.eq_ignore_ascii_case("default")
                || norm_cond.eq_ignore_ascii_case("none");
        }
    };

    match ctx {
        serde_json::Value::String(s) => {
            let s_lower = s.trim().to_lowercase();
            let cond_lower = norm_cond.to_lowercase();
            s_lower == cond_lower || s_lower.contains(&cond_lower) || cond_lower.contains(&s_lower)
        }
        serde_json::Value::Object(map) => {
            let clauses = norm_cond.split("&&");
            for clause in clauses {
                let sub_clauses = clause.split(" and ");
                for sub in sub_clauses {
                    if !match_single_clause(sub.trim(), map) {
                        return false;
                    }
                }
            }
            true
        }
        _ => false,
    }
}

fn match_single_clause(clause: &str, map: &serde_json::Map<String, serde_json::Value>) -> bool {
    if clause.is_empty() || clause == "*" || clause.eq_ignore_ascii_case("true") {
        return true;
    }

    // Equality: key == 'val' or key = val
    if let Some((k, v)) = clause.split_once("==").or_else(|| clause.split_once('=')) {
        let key = k.trim();
        let target_val = v.trim().trim_matches('\'').trim_matches('"');
        if let Some(actual) = map.get(key) {
            let actual_str = match actual {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Bool(b) => b.to_string(),
                serde_json::Value::Number(n) => n.to_string(),
                _ => actual.to_string(),
            };
            return actual_str.eq_ignore_ascii_case(target_val);
        }
        return false;
    }

    // Inequality: key != 'val'
    if let Some((k, v)) = clause.split_once("!=") {
        let key = k.trim();
        let target_val = v.trim().trim_matches('\'').trim_matches('"');
        if let Some(actual) = map.get(key) {
            let actual_str = match actual {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Bool(b) => b.to_string(),
                serde_json::Value::Number(n) => n.to_string(),
                _ => actual.to_string(),
            };
            return !actual_str.eq_ignore_ascii_case(target_val);
        }
        return true;
    }

    // Set membership: key in [a, b]
    if let Some((k, list_part)) = clause.split_once(" in ") {
        let key = k.trim();
        let list_str = list_part
            .trim()
            .trim_start_matches('[')
            .trim_end_matches(']');
        if let Some(actual) = map.get(key) {
            let actual_str = match actual {
                serde_json::Value::String(s) => s.clone(),
                _ => actual.to_string(),
            };
            for item in list_str.split(',') {
                let clean_item = item.trim().trim_matches('\'').trim_matches('"');
                if actual_str.eq_ignore_ascii_case(clean_item) {
                    return true;
                }
            }
        }
        return false;
    }

    let clean = clause.trim_matches('\'').trim_matches('"').to_lowercase();
    if let Some(v) = map.get(&clean) {
        if v.as_bool() == Some(true) || v.as_str() == Some("true") {
            return true;
        }
    }

    for (k, v) in map {
        if k.eq_ignore_ascii_case(&clean) {
            return true;
        }
        if let Some(s) = v.as_str() {
            if s.eq_ignore_ascii_case(&clean) {
                return true;
            }
        }
    }

    false
}

pub fn evaluate_policy_latch(
    state: Option<&PolicyLatchEntityState>,
    decision_tree: &[DecisionCase],
    kind_spec: Option<&KindSpec>,
    input: &PolicyLatchInput,
    now: i64,
    status_latched: bool,
) -> Result<PolicyLatchOutcome, CoreError> {
    // 1. Entity presence
    let state = match state {
        Some(s) => s,
        None => {
            return Ok(PolicyLatchOutcome {
                allowed: false,
                latched: false,
                requires_human: false,
                recommendation: PolicyLatchRecommendation::Block,
                reason: PolicyLatchReason::EntityNotFound,
                explanation: format!(
                    "Entity '{}:{}' does not exist in store.",
                    input.key.kind, input.key.id
                ),
                trust: 0.0,
                status: LifecycleStatus::Probation,
                matched_case: None,
                decision: None,
                escalation_instructions: None,
            });
        }
    };

    // 2. Status latch check
    if state.status == LifecycleStatus::Retired
        || state.status == LifecycleStatus::Quarantined
        || status_latched
    {
        let status_str = format!("{:?}", state.status).to_lowercase();
        return Ok(PolicyLatchOutcome {
            allowed: false,
            latched: true,
            requires_human: true,
            recommendation: PolicyLatchRecommendation::EscalateToHuman,
            reason: PolicyLatchReason::StatusLatched,
            explanation: format!(
                "Entity '{}' is locked in status latch '{}'. High-risk mutations are blocked until reinstated by a human.",
                input.key.id, status_str
            ),
            trust: state.evidence.k / state.evidence.n.max(1.0),
            status: state.status,
            matched_case: None,
            decision: None,
            escalation_instructions: Some(format!(
                "Run 'medha reinstate --id {} --reason \"<justification>\"' with a human author to lift the latch.",
                input.key.id
            )),
        });
    }

    let default_thresholds = Thresholds::default();
    let thresholds = kind_spec
        .map(|k| &k.thresholds)
        .unwrap_or(&default_thresholds);
    let default_recency = RecencyConfig::default();
    let recency = kind_spec.map(|k| &k.recency).unwrap_or(&default_recency);

    // 3. Decision tree evaluation
    if !decision_tree.is_empty() {
        let mut scored_tree = Vec::with_capacity(decision_tree.len());
        for case in decision_tree {
            scored_tree.push(score_decision_case(case, now, thresholds, recency)?);
        }

        let mut matched_case: Option<ScoredDecisionCase> = None;
        for sc in scored_tree {
            if match_condition(&sc.kase.condition, input.context.as_ref()) {
                matched_case = Some(sc);
                break;
            }
        }

        if let Some(matched) = matched_case {
            if matched.status == LifecycleStatus::Retired
                || matched.status == LifecycleStatus::Quarantined
            {
                return Ok(PolicyLatchOutcome {
                    allowed: false,
                    latched: true,
                    requires_human: true,
                    recommendation: PolicyLatchRecommendation::EscalateToHuman,
                    reason: PolicyLatchReason::BranchUntrusted,
                    explanation: format!(
                        "Decision branch '{}' ({}) has latched status '{:?}'.",
                        matched.kase.id, matched.kase.condition, matched.status
                    ),
                    trust: matched.trust,
                    status: matched.status,
                    decision: Some(matched.kase.decision.clone()),
                    matched_case: Some(matched),
                    escalation_instructions: Some(
                        "Review branch and record human review or new evidence.".to_string(),
                    ),
                });
            }

            let dec_type_str = match &matched.kase.decision {
                Decision::Apply => "apply",
                Decision::Ignore => "ignore",
                Decision::Probability { .. } => "probability",
            };

            let req_human = kind_spec
                .and_then(|k| k.decision_policy.as_ref())
                .and_then(|p| p.require_human_for.as_ref());
            let is_gated = req_human
                .map(|list| list.iter().any(|s| s == dec_type_str))
                .unwrap_or(false);

            if is_gated && !is_human_author(input.author.as_deref()) {
                return Ok(PolicyLatchOutcome {
                    allowed: false,
                    latched: true,
                    requires_human: true,
                    recommendation: PolicyLatchRecommendation::EscalateToHuman,
                    reason: PolicyLatchReason::RequireHumanGate,
                    explanation: format!(
                        "Kind '{}' gates '{}' decisions via requireHumanFor. Author '{}' is not a verified human.",
                        input.key.kind,
                        dec_type_str,
                        input.author.as_deref().unwrap_or("anonymous")
                    ),
                    trust: matched.trust,
                    status: matched.status,
                    decision: Some(matched.kase.decision.clone()),
                    matched_case: Some(matched),
                    escalation_instructions: Some(
                        "A human operator must authorize this action (author format: human:<username>).".to_string(),
                    ),
                });
            }

            match &matched.kase.decision {
                Decision::Apply => {
                    if let Some(min_t) = input.min_trust {
                        if matched.trust < min_t {
                            return Ok(PolicyLatchOutcome {
                                allowed: false,
                                latched: false,
                                requires_human: false,
                                recommendation: PolicyLatchRecommendation::Block,
                                reason: PolicyLatchReason::BranchUntrusted,
                                explanation: format!(
                                    "Decision branch '{}' trust ({:.3}) is below required minTrust ({:.3}).",
                                    matched.kase.id, matched.trust, min_t
                                ),
                                trust: matched.trust,
                                status: matched.status,
                                decision: Some(matched.kase.decision.clone()),
                                matched_case: Some(matched),
                                escalation_instructions: None,
                            });
                        }
                    }
                    return Ok(PolicyLatchOutcome {
                        allowed: true,
                        latched: false,
                        requires_human: false,
                        recommendation: PolicyLatchRecommendation::Proceed,
                        reason: PolicyLatchReason::Approved,
                        explanation: format!(
                            "Decision branch '{}' ({}) approves application with trust {:.3}.",
                            matched.kase.id, matched.kase.condition, matched.trust
                        ),
                        trust: matched.trust,
                        status: matched.status,
                        decision: Some(matched.kase.decision.clone()),
                        matched_case: Some(matched),
                        escalation_instructions: None,
                    });
                }
                Decision::Ignore => {
                    return Ok(PolicyLatchOutcome {
                        allowed: false,
                        latched: false,
                        requires_human: false,
                        recommendation: PolicyLatchRecommendation::Skip,
                        reason: PolicyLatchReason::DecisionIgnore,
                        explanation: format!(
                            "Decision branch '{}' ({}) prescribes ignore for this context.",
                            matched.kase.id, matched.kase.condition
                        ),
                        trust: matched.trust,
                        status: matched.status,
                        decision: Some(matched.kase.decision.clone()),
                        matched_case: Some(matched),
                        escalation_instructions: None,
                    });
                }
                Decision::Probability { value } => {
                    let allowed = *value >= 0.5;
                    return Ok(PolicyLatchOutcome {
                        allowed,
                        latched: false,
                        requires_human: false,
                        recommendation: if allowed {
                            PolicyLatchRecommendation::Proceed
                        } else {
                            PolicyLatchRecommendation::Skip
                        },
                        reason: if allowed {
                            PolicyLatchReason::Approved
                        } else {
                            PolicyLatchReason::DecisionIgnore
                        },
                        explanation: format!(
                            "Decision branch '{}' prescribes probability {:.2}.",
                            matched.kase.id, value
                        ),
                        trust: matched.trust,
                        status: matched.status,
                        decision: Some(matched.kase.decision.clone()),
                        matched_case: Some(matched),
                        escalation_instructions: None,
                    });
                }
            }
        }
    }

    // 4. Default evaluation when no branch matches or tree is empty. Gate on the calibrated
    // trust (as the TS kernel does), not the raw success ratio: 1/1 successes is not trust 1.0.
    let current_trust = state
        .trust
        .unwrap_or_else(|| state.evidence.k / state.evidence.n.max(1.0));
    let req_human = kind_spec
        .and_then(|k| k.decision_policy.as_ref())
        .and_then(|p| p.require_human_for.as_ref());
    let is_gated = req_human
        .map(|list| list.iter().any(|s| s == "apply"))
        .unwrap_or(false);

    if is_gated && !is_human_author(input.author.as_deref()) {
        return Ok(PolicyLatchOutcome {
            allowed: false,
            latched: true,
            requires_human: true,
            recommendation: PolicyLatchRecommendation::EscalateToHuman,
            reason: PolicyLatchReason::RequireHumanGate,
            explanation: format!(
                "Kind '{}' gates applications via requireHumanFor. Author '{}' is not a verified human.",
                input.key.kind,
                input.author.as_deref().unwrap_or("anonymous")
            ),
            trust: current_trust,
            status: state.status,
            matched_case: None,
            decision: None,
            escalation_instructions: Some(
                "A human operator must authorize this action (author format: human:<username>).".to_string(),
            ),
        });
    }

    if state.status == LifecycleStatus::Trusted || state.status == LifecycleStatus::Active {
        if let Some(min_t) = input.min_trust {
            if current_trust < min_t {
                return Ok(PolicyLatchOutcome {
                    allowed: false,
                    latched: false,
                    requires_human: false,
                    recommendation: PolicyLatchRecommendation::Block,
                    reason: PolicyLatchReason::EntityUntrusted,
                    explanation: format!(
                        "Entity trust ({:.3}) is below required minTrust ({:.3}).",
                        current_trust, min_t
                    ),
                    trust: current_trust,
                    status: state.status,
                    matched_case: None,
                    decision: None,
                    escalation_instructions: None,
                });
            }
        }
        return Ok(PolicyLatchOutcome {
            allowed: true,
            latched: false,
            requires_human: false,
            recommendation: PolicyLatchRecommendation::Proceed,
            reason: PolicyLatchReason::Approved,
            explanation: format!(
                "Entity '{}' is {:?} with trust {:.3}.",
                input.key.id, state.status, current_trust
            ),
            trust: current_trust,
            status: state.status,
            matched_case: None,
            decision: None,
            escalation_instructions: None,
        });
    }

    Ok(PolicyLatchOutcome {
        allowed: false,
        latched: false,
        requires_human: false,
        recommendation: PolicyLatchRecommendation::Block,
        reason: PolicyLatchReason::EntityUntrusted,
        explanation: format!(
            "Entity '{}' is in status '{:?}' (untrusted).",
            input.key.id, state.status
        ),
        trust: current_trust,
        status: state.status,
        matched_case: None,
        decision: None,
        escalation_instructions: None,
    })
}
