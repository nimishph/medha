use crate::drift::ema_step;
use crate::formula::{compute_trust_and_status, TrustComputationInput};
use crate::round::round6;
use crate::thresholds::{DEFAULT_EMA_ALPHA, WEEK_MS};
use crate::types::{
    CoreError, EmaState, Evidence, GuardState, KindConvergenceGates, LifecycleStatus, RecencyConfig, SignalSpec,
    Thresholds,
};
use std::collections::{BTreeSet, HashMap, HashSet};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuthorLedger {
    #[serde(default, alias = "last_at")]
    pub last_at: Option<i64>,
    #[serde(default)]
    pub counted: u64,
    #[serde(default)]
    pub suppressed: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SignalLimits {
    #[serde(default, alias = "min_interval_ms")]
    pub min_interval_ms: Option<i64>,
    #[serde(default, alias = "max_successes_per_author")]
    pub max_successes_per_author: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct KindDecisionPolicy {
    #[serde(default, alias = "require_human_for")]
    pub require_human_for: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct KindSpec {
    #[serde(default, alias = "kind")]
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub thresholds: Thresholds,
    #[serde(default)]
    pub recency: RecencyConfig,
    #[serde(default, alias = "evidence_weighting")]
    pub evidence_weighting: Option<String>,
    #[serde(default, alias = "signal_limits")]
    pub signal_limits: Option<SignalLimits>,
    #[serde(default, alias = "decision_policy")]
    pub decision_policy: Option<KindDecisionPolicy>,
    #[serde(default, alias = "convergence_gates")]
    pub convergence_gates: Option<KindConvergenceGates>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EntityFoldState {
    pub evidence: Evidence,
    pub guard: GuardState,
    pub anchors: HashSet<(String, String)>,
    pub ema: EmaState,
    pub last_signal_at: Option<i64>,
    pub status: LifecycleStatus,
    pub status_override: Option<LifecycleStatus>,
    pub authors: HashMap<String, AuthorLedger>,
    /// Distinct authors of the failed trials; kept only when the kind requires more than one
    /// rejecting author before retirement (spec §6 step 5.1).
    pub rejecting_authors: BTreeSet<String>,
    /// Distinct agent roles observed among successes (medha-c8z.3).
    pub observed_roles: Vec<String>,
}

impl Default for EntityFoldState {
    fn default() -> Self {
        Self {
            evidence: Evidence::default(),
            guard: GuardState::default(),
            anchors: HashSet::new(),
            ema: EmaState::default(),
            last_signal_at: None,
            status: LifecycleStatus::Probation,
            status_override: None,
            authors: HashMap::new(),
            rejecting_authors: BTreeSet::new(),
            observed_roles: Vec::new(),
        }
    }
}

pub fn canonical_signals() -> HashMap<String, SignalSpec> {
    let mut map = HashMap::new();
    map.insert(
        "APPLY".to_string(),
        SignalSpec {
            name: "APPLY".to_string(),
            value: 1.0,
            counts_as_trial: true,
            counts_as_success: true,
            description: Some("Applied and succeeded".to_string()),
        },
    );
    map.insert(
        "REJECT_RULE".to_string(),
        SignalSpec {
            name: "REJECT_RULE".to_string(),
            value: -1.0,
            counts_as_trial: true,
            counts_as_success: false,
            description: Some("Rejected as wrong rule".to_string()),
        },
    );
    map.insert(
        "REJECT_CONTEXT".to_string(),
        SignalSpec {
            name: "REJECT_CONTEXT".to_string(),
            value: -0.2,
            counts_as_trial: false,
            counts_as_success: false,
            description: Some("Rejected due to context".to_string()),
        },
    );
    map.insert(
        "SKIP".to_string(),
        SignalSpec {
            name: "SKIP".to_string(),
            value: 0.0,
            counts_as_trial: false,
            counts_as_success: false,
            description: Some("Skipped / not applicable".to_string()),
        },
    );
    map.insert(
        "ADOPTED".to_string(),
        SignalSpec {
            name: "ADOPTED".to_string(),
            value: 0.6,
            counts_as_trial: true,
            counts_as_success: true,
            description: Some("Adopted with weight 0.6".to_string()),
        },
    );
    map.insert(
        "HEURISTIC".to_string(),
        SignalSpec {
            name: "HEURISTIC".to_string(),
            value: 0.3,
            counts_as_trial: true,
            counts_as_success: true,
            description: Some("Heuristic success".to_string()),
        },
    );
    map.insert(
        "FLAKY".to_string(),
        SignalSpec {
            name: "FLAKY".to_string(),
            value: -0.5,
            counts_as_trial: true,
            counts_as_success: false,
            description: Some("Flaky trial failure".to_string()),
        },
    );
    map
}

pub fn fold_signal_step(
    mut state: EntityFoldState,
    signal_name: &str,
    at: i64,
    author: Option<&str>,
    anchors: Option<&[Vec<String>]>,
    signals: &HashMap<String, SignalSpec>,
    kind_spec: &KindSpec,
) -> Result<EntityFoldState, CoreError> {
    let spec = signals
        .get(signal_name)
        .ok_or_else(|| CoreError::UnknownSignal(signal_name.to_string()))?;

    // Signal limits (author rate limiting)
    if let Some(lim) = &kind_spec.signal_limits {
        if spec.counts_as_success {
            let who = author.unwrap_or("").to_string();
            let mut led = state.authors.get(&who).cloned().unwrap_or(AuthorLedger {
                last_at: None,
                counted: 0,
                suppressed: 0,
            });

            let too_soon = if let Some(min_int) = lim.min_interval_ms {
                led.last_at.map(|l| at - l < min_int).unwrap_or(false)
            } else {
                false
            };

            let over_cap = if let Some(max_s) = lim.max_successes_per_author {
                led.counted >= max_s
            } else {
                false
            };

            if too_soon || over_cap {
                led.suppressed += 1;
                state.authors.insert(who, led);
                return Ok(state);
            }

            led.last_at = Some(at);
            led.counted += 1;
            state.authors.insert(who, led);
        }
    }

    if kind_spec.thresholds.min_distinct_authors_for_retired > 1
        && spec.counts_as_trial
        && !spec.counts_as_success
    {
        state
            .rejecting_authors
            .insert(author.unwrap_or("").to_string());
    }

    if kind_spec.evidence_weighting.as_deref() == Some("signal-value") {
        let tw = if spec.counts_as_trial {
            spec.value.abs()
        } else {
            0.0
        };
        let sw = if spec.counts_as_success {
            spec.value.max(0.0)
        } else {
            0.0
        };
        state.evidence.k = round6(state.evidence.k + sw)?;
        state.evidence.n = round6(state.evidence.n + tw)?;
    } else {
        if spec.counts_as_success {
            state.evidence.k += 1.0;
        }
        if spec.counts_as_trial {
            state.evidence.n += 1.0;
        }
    }

    if signal_name == "REJECT_CONTEXT" {
        state.evidence.context_rejects += 1;
    }

    state.ema.mu = ema_step(Some(state.ema.mu), spec.value, DEFAULT_EMA_ALPHA)?;

    if spec.counts_as_success {
        if let Some(anchs) = anchors {
            for a in anchs {
                if a.len() >= 2 {
                    state.anchors.insert((a[0].clone(), a[1].clone()));
                }
            }
        } else {
            let week = (at as f64 / WEEK_MS).floor() as i64;
            state.anchors.insert(("week".to_string(), week.to_string()));
        }
    }

    if spec.counts_as_success {
        if let Some(auth) = author {
            let role = if let Some((r, _)) = auth.split_once(':') {
                r.trim().to_lowercase()
            } else {
                auth.trim().to_lowercase()
            };
            if !role.is_empty() && !state.observed_roles.contains(&role) {
                state.observed_roles.push(role);
                state.observed_roles.sort();
            }
        }
        state.last_signal_at = Some(at);
    }

    // Status lag: recompute on the state that still carries the previous status
    let res = compute_trust_and_status(TrustComputationInput {
        evidence: &state.evidence,
        guard: &state.guard,
        distinct_anchor_count: state.anchors.len(),
        ema: &state.ema,
        last_signal_at: state.last_signal_at,
        now: at,
        stored_status: state.status,
        status_override: state.status_override,
        thresholds: &kind_spec.thresholds,
        recency_config: &kind_spec.recency,
        rejecting_authors: Some(state.rejecting_authors.len()),
        observed_roles: Some(&state.observed_roles),
        convergence_gates: kind_spec.convergence_gates.as_ref(),
    })?;

    state.status = res.status;
    Ok(state)
}

pub fn fold_guard_step(
    mut state: EntityFoldState,
    guard_kind: Option<&str>,
    ok: bool,
    at: i64,
    kind_spec: &KindSpec,
) -> Result<EntityFoldState, CoreError> {
    if let Some(gk) = guard_kind {
        state.guard.kind = gk.to_string();
    }
    state.guard.last_ok = Some(ok);
    state.guard.last_ok_at = Some(at);

    let res = compute_trust_and_status(TrustComputationInput {
        evidence: &state.evidence,
        guard: &state.guard,
        distinct_anchor_count: state.anchors.len(),
        ema: &state.ema,
        last_signal_at: state.last_signal_at,
        now: at,
        stored_status: state.status,
        status_override: state.status_override,
        thresholds: &kind_spec.thresholds,
        recency_config: &kind_spec.recency,
        rejecting_authors: Some(state.rejecting_authors.len()),
        observed_roles: Some(&state.observed_roles),
        convergence_gates: kind_spec.convergence_gates.as_ref(),
    })?;

    state.status = res.status;
    Ok(state)
}
