use crate::types::{EntityState, Episode, EpisodePayload};
use medha_core::drift::ema_step;
use medha_core::formula::{compute_trust_and_status, TrustComputationInput};
use medha_core::thresholds::{DEFAULT_EMA_ALPHA, DEFAULT_THETA0, WEEK_MS};
use medha_core::types::{
    EmaState, EntityKey, Evidence, GuardState, LifecycleStatus, RecencyConfig, Thresholds,
};
use medha_core::decision::DecisionCase;
use std::collections::HashMap;

pub fn fresh_state(key: EntityKey) -> EntityState {
    EntityState {
        key,
        evidence: Evidence::default(),
        guard: GuardState::default(),
        anchors: Vec::new(),
        ema: EmaState::default(),
        status: LifecycleStatus::Probation,
        status_override: None,
        last_signal_at: None,
        updater: "ema".to_string(),
        decision_tree: Vec::new(),
    }
}

pub fn fold_episode_into_state(
    current: Option<EntityState>,
    episode: &Episode,
) -> Option<EntityState> {
    let mut state = current.unwrap_or_else(|| fresh_state(episode.key.clone()));
    let thresholds = Thresholds::default();
    let recency_config = RecencyConfig::default();

    match &episode.payload {
        EpisodePayload::Signal {
            spec,
            anchors,
            weight,
            case_id,
            ..
        } => {
            // If targeted to a decision tree branch
            if let Some(cid) = case_id {
                if let Some(branch) = state.decision_tree.iter_mut().find(|c| &c.id == cid) {
                    if spec.counts_as_success {
                        branch.evidence.k += 1.0;
                    }
                    if spec.counts_as_trial {
                        branch.evidence.n += 1.0;
                    }
                    if let Ok(new_mu) = ema_step(Some(branch.ema.mu), spec.value, DEFAULT_EMA_ALPHA) {
                        branch.ema.mu = new_mu;
                    }
                }
            }

            if spec.counts_as_success {
                state.evidence.k += 1.0;
            }
            if spec.counts_as_trial {
                state.evidence.n += 1.0;
            }

            let next_mu = if let Some(w) = weight {
                *w
            } else {
                ema_step(Some(state.ema.mu), spec.value, DEFAULT_EMA_ALPHA).unwrap_or(state.ema.mu)
            };
            state.ema.mu = next_mu;

            if spec.counts_as_success {
                if let Some(anchs) = anchors {
                    for a in anchs {
                        if !state.anchors.iter().any(|existing| existing == a) {
                            state.anchors.push(a.clone());
                        }
                    }
                } else {
                    let week = (episode.at as f64 / WEEK_MS).floor() as i64;
                    let fallback = medha_core::types::Anchor::new("week", week.to_string());
                    if !state.anchors.iter().any(|existing| existing == &fallback) {
                        state.anchors.push(fallback);
                    }
                }
            }

            if spec.counts_as_success {
                state.last_signal_at = Some(episode.at);
            }

            if let Ok(res) = compute_trust_and_status(TrustComputationInput {
                evidence: &state.evidence,
                guard: &state.guard,
                distinct_anchor_count: state.anchors.len(),
                ema: &state.ema,
                last_signal_at: state.last_signal_at,
                now: episode.at,
                stored_status: state.status,
                status_override: state.status_override,
                thresholds: &thresholds,
                recency_config: &recency_config,
            }) {
                state.status = res.status;
            }
            Some(state)
        }
        EpisodePayload::Guard { ok, kind, .. } => {
            if let Some(k) = kind {
                state.guard.kind = k.clone();
            }
            state.guard.last_ok = Some(*ok);
            state.guard.last_ok_at = Some(episode.at);

            if let Ok(res) = compute_trust_and_status(TrustComputationInput {
                evidence: &state.evidence,
                guard: &state.guard,
                distinct_anchor_count: state.anchors.len(),
                ema: &state.ema,
                last_signal_at: state.last_signal_at,
                now: episode.at,
                stored_status: state.status,
                status_override: state.status_override,
                thresholds: &thresholds,
                recency_config: &recency_config,
            }) {
                state.status = res.status;
            }
            Some(state)
        }
        EpisodePayload::Override { override_type, .. } => {
            match override_type.as_str() {
                "retired" => {
                    state.status_override = Some(LifecycleStatus::Retired);
                    state.status = LifecycleStatus::Retired;
                }
                "quarantined" => {
                    state.status_override = Some(LifecycleStatus::Quarantined);
                    state.status = LifecycleStatus::Quarantined;
                }
                "restore" => {
                    state.status_override = None;
                    if let Ok(res) = compute_trust_and_status(TrustComputationInput {
                        evidence: &state.evidence,
                        guard: &state.guard,
                        distinct_anchor_count: state.anchors.len(),
                        ema: &state.ema,
                        last_signal_at: state.last_signal_at,
                        now: episode.at,
                        stored_status: LifecycleStatus::Probation,
                        status_override: None,
                        thresholds: &thresholds,
                        recency_config: &recency_config,
                    }) {
                        state.status = res.status;
                    }
                }
                _ => {}
            }
            Some(state)
        }
        EpisodePayload::Proposal { theta0, .. } => {
            if let Some(t0) = theta0 {
                state.ema.theta0 = *t0;
                state.ema.mu = *t0;
            }
            Some(state)
        }
        EpisodePayload::Sweep { action, .. } => {
            match action.as_str() {
                "purge" => None,
                "quarantine" => {
                    state.status_override = Some(LifecycleStatus::Quarantined);
                    state.status = LifecycleStatus::Quarantined;
                    Some(state)
                }
                "retire" => {
                    state.status_override = Some(LifecycleStatus::Retired);
                    state.status = LifecycleStatus::Retired;
                    Some(state)
                }
                _ => Some(state),
            }
        }
        EpisodePayload::Baseline { state: b_state } => Some(b_state.clone()),
        EpisodePayload::Decision {
            case_id,
            parent_id,
            condition,
            decision,
        } => {
            let existing_idx = state.decision_tree.iter().position(|c| &c.id == case_id);
            if let Some(idx) = existing_idx {
                state.decision_tree[idx].condition = condition.clone();
                state.decision_tree[idx].decision = decision.clone();
                if parent_id.is_some() {
                    state.decision_tree[idx].parent_id = parent_id.clone();
                }
            } else {
                state.decision_tree.push(DecisionCase {
                    id: case_id.clone(),
                    parent_id: parent_id.clone(),
                    condition: condition.clone(),
                    decision: decision.clone(),
                    evidence: Evidence::default(),
                    ema: EmaState {
                        mu: DEFAULT_THETA0,
                        theta0: DEFAULT_THETA0,
                        sample_count: 0,
                    },
                });
            }
            Some(state)
        }
        EpisodePayload::Retract { .. } => Some(state),
        EpisodePayload::Define { .. } => Some(state),
    }
}

pub fn fold_log(episodes: &[Episode]) -> HashMap<String, EntityState> {
    let mut projection: HashMap<String, EntityState> = HashMap::new();

    // Collect retractions
    let mut retracted_seqs = std::collections::HashSet::new();
    for ep in episodes {
        if let EpisodePayload::Retract { target_seq, .. } = &ep.payload {
            retracted_seqs.insert(*target_seq);
        }
    }

    for ep in episodes {
        if retracted_seqs.contains(&ep.seq) {
            continue;
        }
        let key_str = ep.key.to_string_repr();
        let curr = projection.remove(&key_str);
        if let Some(next) = fold_episode_into_state(curr, ep) {
            projection.insert(key_str, next);
        }
    }

    projection
}
