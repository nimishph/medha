use std::collections::{HashMap, HashSet};
use medha_core::formula::{compute_trust_and_status, TrustComputationInput};
use medha_core::round::round6;
use medha_core::thresholds::{DEFAULT_THETA0, RECENCY_FLOOR, RECENCY_HALF_LIFE_DAYS};
use medha_core::types::{Anchor, CoreError, EntityKey, LifecycleStatus, RecencyConfig, Thresholds};
use medha_store::{EntityState, Episode, EpisodeInput, EpisodePayload};

pub fn canonical_episode_key(episode: &Episode) -> String {
    let retract_target = match &episode.payload {
        EpisodePayload::Retract { target_seq, .. } => target_seq.to_string(),
        _ => String::new(),
    };
    content_key(&episode.key, episode.at, &episode.payload, &retract_target)
}

pub fn canonical_episode_input_key(episode: &EpisodeInput) -> String {
    let retract_target = match &episode.payload {
        EpisodePayload::Retract { target_seq, .. } => target_seq.to_string(),
        _ => String::new(),
    };
    content_key(&episode.key, episode.at, &episode.payload, &retract_target)
}

fn content_key(
    key: &EntityKey,
    at: i64,
    payload: &EpisodePayload,
    retract_target: &str,
) -> String {
    let type_str = match payload {
        EpisodePayload::Signal { .. } => "signal",
        EpisodePayload::Guard { .. } => "guard",
        EpisodePayload::Override { .. } => "override",
        EpisodePayload::Proposal { .. } => "proposal",
        EpisodePayload::Sweep { .. } => "sweep",
        EpisodePayload::Baseline { .. } => "baseline",
        EpisodePayload::Retract { .. } => "retract",
        EpisodePayload::Define { .. } => "define",
        EpisodePayload::Decision { .. } => "decision",
    };

    let mut parts: Vec<String> = vec![
        key.namespace.clone(),
        key.kind.clone(),
        key.id.clone(),
        at.to_string(),
        type_str.to_string(),
    ];

    match payload {
        EpisodePayload::Signal {
            spec,
            anchors,
            run_ref,
            updater,
            weight,
            ..
        } => {
            parts.push(spec.name.clone());
            parts.push(spec.value.to_string());
            parts.push(spec.counts_as_trial.to_string());
            parts.push(spec.counts_as_success.to_string());
            parts.push(run_ref.clone().unwrap_or_default());
            parts.push(updater.clone().unwrap_or_default());
            if let Some(w) = weight {
                parts.push(w.to_string());
            }
            if let Some(anchs) = anchors {
                let mut sorted_anchors: Vec<String> = anchs
                    .iter()
                    .map(|a| format!("{}:{}", a.kind, a.value))
                    .collect();
                sorted_anchors.sort();
                parts.push(sorted_anchors.join(","));
            }
        }
        EpisodePayload::Guard { ok, kind, .. } => {
            parts.push(ok.to_string());
            parts.push(kind.clone().unwrap_or_default());
        }
        EpisodePayload::Override {
            override_type,
            reason,
        } => {
            parts.push(override_type.clone());
            parts.push(reason.clone());
        }
        EpisodePayload::Proposal {
            provenance,
            description,
            ..
        } => {
            parts.push(provenance.clone());
            parts.push(description.clone().unwrap_or_default());
        }
        EpisodePayload::Sweep { action, reason } => {
            parts.push(action.clone());
            parts.push(reason.clone());
        }
        EpisodePayload::Baseline { state } => {
            parts.push(state.key.to_string_repr());
            parts.push(state.evidence.k.to_string());
            parts.push(state.evidence.n.to_string());
            parts.push(state.ema.mu.to_string());
            parts.push(format!("{:?}", state.status).to_lowercase());
        }
        EpisodePayload::Retract { reason, .. } => {
            parts.push(retract_target.to_string());
            parts.push(reason.clone());
        }
        EpisodePayload::Define {
            title,
            tags,
            rationale,
            ..
        } => {
            parts.push(title.clone().unwrap_or_default());
            parts.push(rationale.clone().unwrap_or_default());
            let mut sorted_tags = tags.clone().unwrap_or_default();
            sorted_tags.sort();
            parts.push(sorted_tags.join(","));
        }
        EpisodePayload::Decision {
            case_id,
            parent_id,
            condition,
            decision,
        } => {
            parts.push(case_id.clone());
            parts.push(parent_id.clone().unwrap_or_default());
            parts.push(condition.clone());
            match decision {
                medha_core::decision::Decision::Apply => {
                    parts.push("apply".to_string());
                }
                medha_core::decision::Decision::Ignore => {
                    parts.push("ignore".to_string());
                }
                medha_core::decision::Decision::Probability { value } => {
                    parts.push("probability".to_string());
                    parts.push(value.to_string());
                }
            }
        }
    }

    parts.join("\0")
}

fn dangling_target(target_seq: u64) -> String {
    format!("\0<unresolved-target>{}", target_seq)
}

#[derive(Clone, Debug)]
struct Identity {
    id: String,
    target_id: Option<String>,
}

fn compute_identities(log: &[Episode]) -> HashMap<u64, Identity> {
    let mut own = HashMap::new();
    for ep in log {
        own.insert(ep.seq, content_key(&ep.key, ep.at, &ep.payload, ""));
    }

    let mut by_seq = HashMap::new();
    for ep in log {
        match &ep.payload {
            EpisodePayload::Retract { target_seq, .. } => {
                let target_key = own.get(target_seq).cloned();
                let fallback = dangling_target(*target_seq);
                let stand_in = target_key.as_deref().unwrap_or(&fallback);
                let id = content_key(&ep.key, ep.at, &ep.payload, stand_in);
                by_seq.insert(ep.seq, Identity { id, target_id: target_key });
            }
            _ => {
                let id = content_key(&ep.key, ep.at, &ep.payload, "");
                by_seq.insert(ep.seq, Identity { id, target_id: None });
            }
        }
    }

    by_seq
}

pub fn merge_episodes(local: &[Episode], incoming: &[Episode]) -> Vec<Episode> {
    let mut map: HashMap<String, (Episode, Option<String>)> = HashMap::new();

    let mut collect = |log: &[Episode], ids: HashMap<u64, Identity>| {
        for ep in log {
            if let Some(identity) = ids.get(&ep.seq) {
                if !map.contains_key(&identity.id) {
                    map.insert(identity.id.clone(), (ep.clone(), identity.target_id.clone()));
                }
            }
        }
    };

    collect(local, compute_identities(local));
    collect(incoming, compute_identities(incoming));

    let mut entries: Vec<(String, Episode, Option<String>)> = map
        .into_iter()
        .map(|(id, (ep, target_id))| (id, ep, target_id))
        .collect();

    // Deterministic total ordering matching TS:
    // 1. at timestamp
    // 2. key string repr
    // 3. payload type string
    // 4. id content key
    entries.sort_by(|(a_id, a, _), (b_id, b, _)| {
        if a.at != b.at {
            return a.at.cmp(&b.at);
        }
        let key_a = a.key.to_string_repr();
        let key_b = b.key.to_string_repr();
        if key_a != key_b {
            return key_a.cmp(&key_b);
        }
        let type_a = match &a.payload {
            EpisodePayload::Signal { .. } => "signal",
            EpisodePayload::Guard { .. } => "guard",
            EpisodePayload::Override { .. } => "override",
            EpisodePayload::Proposal { .. } => "proposal",
            EpisodePayload::Sweep { .. } => "sweep",
            EpisodePayload::Baseline { .. } => "baseline",
            EpisodePayload::Retract { .. } => "retract",
            EpisodePayload::Define { .. } => "define",
            EpisodePayload::Decision { .. } => "decision",
        };
        let type_b = match &b.payload {
            EpisodePayload::Signal { .. } => "signal",
            EpisodePayload::Guard { .. } => "guard",
            EpisodePayload::Override { .. } => "override",
            EpisodePayload::Proposal { .. } => "proposal",
            EpisodePayload::Sweep { .. } => "sweep",
            EpisodePayload::Baseline { .. } => "baseline",
            EpisodePayload::Retract { .. } => "retract",
            EpisodePayload::Define { .. } => "define",
            EpisodePayload::Decision { .. } => "decision",
        };
        if type_a != type_b {
            return type_a.cmp(type_b);
        }
        a_id.cmp(b_id)
    });

    let mut seq_by_id: HashMap<String, u64> = HashMap::new();
    for (idx, (id, _, _)) in entries.iter().enumerate() {
        seq_by_id.insert(id.clone(), idx as u64);
    }

    entries
        .into_iter()
        .enumerate()
        .map(|(idx, (_, mut ep, target_id))| {
            ep.seq = idx as u64;
            if let EpisodePayload::Retract { target_seq, reason } = ep.payload {
                let new_target = match target_id {
                    Some(tid) => seq_by_id.get(&tid).copied().unwrap_or(target_seq),
                    None => target_seq,
                };
                ep.payload = EpisodePayload::Retract {
                    target_seq: new_target,
                    reason,
                };
            }
            ep
        })
        .collect()
}

pub fn merge_entity_states(
    local: &[EntityState],
    incoming: &[EntityState],
) -> Result<Vec<EntityState>, CoreError> {
    let mut map: HashMap<String, EntityState> = HashMap::new();

    for s in local {
        map.insert(s.key.to_string_repr(), s.clone());
    }

    for s in incoming {
        let key = s.key.to_string_repr();
        if let Some(existing) = map.remove(&key) {
            let merged = merge_single_state(&existing, s)?;
            map.insert(key, merged);
        } else {
            map.insert(key, s.clone());
        }
    }

    let mut result: Vec<EntityState> = map.into_values().collect();
    result.sort_by(|a, b| a.key.to_string_repr().cmp(&b.key.to_string_repr()));
    Ok(result)
}

fn merge_single_state(s1: &EntityState, s2: &EntityState) -> Result<EntityState, CoreError> {
    let total_n = s1.evidence.n + s2.evidence.n;
    let total_k = s1.evidence.k + s2.evidence.k;
    let total_context_rejects = s1.evidence.context_rejects + s2.evidence.context_rejects;

    let merged_mu = if total_n == 0.0 {
        (s1.ema.mu + s2.ema.mu) / 2.0
    } else {
        (s1.evidence.n * s1.ema.mu + s2.evidence.n * s2.ema.mu) / total_n
    };
    let merged_mu = round6(merged_mu.clamp(0.0, 1.0))?;

    let updated_at = match (s1.last_signal_at, s2.last_signal_at) {
        (Some(t1), Some(t2)) => Some(t1.max(t2)),
        (Some(t1), None) => Some(t1),
        (None, Some(t2)) => Some(t2),
        (None, None) => None,
    };

    let theta0 = DEFAULT_THETA0;

    // Merge anchors uniquely
    let mut anchor_set: HashSet<String> = HashSet::new();
    let mut merged_anchors: Vec<Anchor> = Vec::new();

    for a in s1.anchors.iter().chain(s2.anchors.iter()) {
        let k = format!("{}\0{}", a.kind, a.value);
        if anchor_set.insert(k) {
            merged_anchors.push(a.clone());
        }
    }
    merged_anchors.sort_by(|a, b| {
        if a.kind != b.kind {
            a.kind.cmp(&b.kind)
        } else {
            a.value.cmp(&b.value)
        }
    });

    // Guard: take latest ok/failure report
    let guard = match (s1.guard.last_ok_at, s2.guard.last_ok_at) {
        (Some(t1), Some(t2)) => {
            if t1 >= t2 {
                s1.guard.clone()
            } else {
                s2.guard.clone()
            }
        }
        (Some(_), None) => s1.guard.clone(),
        (None, Some(_)) => s2.guard.clone(),
        (None, None) => {
            if s1.guard.last_ok.is_some() {
                s1.guard.clone()
            } else {
                s2.guard.clone()
            }
        }
    };

    let last_signal_at = match (s1.last_signal_at, s2.last_signal_at) {
        (Some(t1), Some(t2)) => Some(t1.max(t2)),
        (Some(t1), None) => Some(t1),
        (None, Some(t2)) => Some(t2),
        (None, None) => None,
    };

    let status_override = s1.status_override.or(s2.status_override);

    let status = if s1.status == LifecycleStatus::Quarantined || s2.status == LifecycleStatus::Quarantined {
        LifecycleStatus::Quarantined
    } else if s1.status == LifecycleStatus::Retired && s2.status == LifecycleStatus::Retired {
        LifecycleStatus::Retired
    } else {
        let thresholds = Thresholds::default();
        let recency_config = RecencyConfig {
            half_life_days: RECENCY_HALF_LIFE_DAYS,
            floor: RECENCY_FLOOR,
        };
        let computation = compute_trust_and_status(TrustComputationInput {
            evidence: &medha_core::types::Evidence {
                k: total_k,
                n: total_n,
                context_rejects: total_context_rejects,
            },
            guard: &guard,
            distinct_anchor_count: merged_anchors.len(),
            ema: &medha_core::types::EmaState {
                mu: merged_mu,
                theta0,
                sample_count: (total_n.round() as u64),
            },
            last_signal_at,
            now: updated_at.unwrap_or(0),
            stored_status: LifecycleStatus::Probation,
            status_override,
            thresholds: &thresholds,
            recency_config: &recency_config,
        })?;
        computation.status
    };

    Ok(EntityState {
        key: s1.key.clone(),
        evidence: medha_core::types::Evidence {
            k: total_k,
            n: total_n,
            context_rejects: total_context_rejects,
        },
        guard,
        anchors: merged_anchors,
        ema: medha_core::types::EmaState {
            mu: merged_mu,
            theta0,
            sample_count: (total_n.round() as u64),
        },
        status,
        status_override,
        last_signal_at,
        updater: if !s1.updater.is_empty() {
            s1.updater.clone()
        } else {
            s2.updater.clone()
        },
        decision_tree: s1.decision_tree.clone(),
    })
}
