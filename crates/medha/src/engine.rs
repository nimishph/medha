use std::collections::HashMap;

use crate::config::MedhaConfig;
use crate::errors::MedhaError;
use crate::maintenance::{
    CompactionReport, PreflightReport, SweepChange, SweepOptions, SweepReport,
};
use medha_core::decision::Decision;
use medha_core::formula::{compute_trust_and_status, TrustComputationInput};
use medha_core::round::round6;
use medha_core::thresholds::{
    ACTIVE_THRESHOLD, MIN_USES_FOR_RETIRED, MIN_USES_FOR_TRUSTED, RETIRED_TRUST_THRESHOLD,
    TRUSTED_THRESHOLD,
};
use medha_core::types::{
    Anchor, EntityKey, LifecycleStatus, RecencyConfig, SignalSpec, Thresholds, TrustHint,
};
use medha_store::folding::{fold_episode_into_state, fresh_state};
use medha_store::types::EntityState;
use medha_store::{
    AppendResult, Episode, EpisodeInput, EpisodePayload, MemoryStore, SqliteStore,
    SqliteStoreOptions, StorePort,
};
use medha_sync::{
    FileSyncAdapter, GitRefSyncAdapter, NoopSyncAdapter, PullResult, PushResult, ReconcileResult,
    SyncPort, SyncStatus,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecordInput {
    pub key: EntityKey,
    pub signal: String,
    pub at: i64,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub anchors: Option<Vec<Anchor>>,
    #[serde(default)]
    pub run_ref: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub case_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GuardInput {
    pub key: EntityKey,
    pub ok: bool,
    #[serde(default)]
    pub kind: Option<String>,
    pub at: i64,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShowReport {
    pub key: EntityKey,
    pub known: bool,
    pub hint: TrustHint,
    pub recent_episodes: Vec<Episode>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConditionStatus {
    pub label: String,
    pub met: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GateExplanation {
    pub name: String,
    pub met: bool,
    pub conditions: Vec<ConditionStatus>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThresholdExplanation {
    pub key: EntityKey,
    pub hint: TrustHint,
    pub gates: Vec<GateExplanation>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SimulationReport {
    pub key: EntityKey,
    pub signal: String,
    pub previous_trust: f64,
    pub projected_trust: f64,
    pub trust_delta: f64,
    pub previous_status: LifecycleStatus,
    pub projected_status: LifecycleStatus,
    pub status_changed: bool,
}

pub struct MedhaEngine<S: StorePort, Y: SyncPort> {
    store: S,
    sync: Y,
    config: MedhaConfig,
    signals: HashMap<String, SignalSpec>,
}

impl MedhaEngine<SqliteStore, NoopSyncAdapter> {
    pub fn open_sqlite(db_path: impl Into<String>) -> Result<Self, MedhaError> {
        let path = db_path.into();
        let mut store = SqliteStore::new(SqliteStoreOptions {
            path: path.clone(),
            registries: None,
            resilient_replay: false,
        });
        store.open()?;

        let config = MedhaConfig {
            path: Some(path),
            ..Default::default()
        };

        let signals = medha_core::canonical_signals();

        Ok(Self {
            store,
            sync: NoopSyncAdapter,
            config,
            signals,
        })
    }
}

impl MedhaEngine<MemoryStore, NoopSyncAdapter> {
    pub fn open_in_memory() -> Result<Self, MedhaError> {
        let mut store = MemoryStore::new(None);
        store.open()?;

        let config = MedhaConfig {
            backend: crate::config::BackendKind::Memory,
            path: None,
            ..Default::default()
        };

        let signals = medha_core::canonical_signals();

        Ok(Self {
            store,
            sync: NoopSyncAdapter,
            config,
            signals,
        })
    }
}

impl<S: StorePort> MedhaEngine<S, FileSyncAdapter<MemoryStore>> {
    pub fn with_file_sync(
        store: S,
        file_path: impl AsRef<std::path::Path>,
        config: MedhaConfig,
    ) -> Self {
        let mut temp_store = MemoryStore::new(None);
        let _ = temp_store.open();
        let sync = FileSyncAdapter::new(temp_store, file_path);
        let signals = medha_core::canonical_signals();
        Self {
            store,
            sync,
            config,
            signals,
        }
    }
}

impl<S: StorePort> MedhaEngine<S, GitRefSyncAdapter<MemoryStore>> {
    pub fn with_git_sync(
        store: S,
        repo_dir: impl AsRef<std::path::Path>,
        config: MedhaConfig,
    ) -> Self {
        let mut temp_store = MemoryStore::new(None);
        let _ = temp_store.open();
        let sync = GitRefSyncAdapter::new(temp_store, repo_dir);
        let signals = medha_core::canonical_signals();
        Self {
            store,
            sync,
            config,
            signals,
        }
    }
}

impl<S: StorePort, Y: SyncPort> MedhaEngine<S, Y> {
    pub fn new(store: S, sync: Y, config: MedhaConfig) -> Self {
        let signals = medha_core::canonical_signals();
        Self {
            store,
            sync,
            config,
            signals,
        }
    }

    pub fn store(&self) -> &S {
        &self.store
    }

    pub fn store_mut(&mut self) -> &mut S {
        &mut self.store
    }

    pub fn sync(&self) -> &Y {
        &self.sync
    }

    pub fn sync_mut(&mut self) -> &mut Y {
        &mut self.sync
    }

    pub fn config(&self) -> &MedhaConfig {
        &self.config
    }

    // --- READ PLANE ---

    pub fn get(&self, key: &EntityKey) -> Result<Option<EntityState>, MedhaError> {
        Ok(self.store.get(key)?)
    }

    pub fn list(&self) -> Result<Vec<EntityState>, MedhaError> {
        Ok(self.store.list()?)
    }

    pub fn hint(&self, key: &EntityKey, now: i64) -> Result<TrustHint, MedhaError> {
        let state = self
            .store
            .get(key)?
            .unwrap_or_else(|| fresh_state(key.clone()));

        let thresholds = Thresholds::default();
        let recency_config = RecencyConfig::default();

        let computation = compute_trust_and_status(TrustComputationInput {
            evidence: &state.evidence,
            guard: &state.guard,
            distinct_anchor_count: state.anchors.len(),
            ema: &state.ema,
            last_signal_at: state.last_signal_at,
            now,
            stored_status: state.status,
            status_override: state.status_override,
            thresholds: &thresholds,
            recency_config: &recency_config,
        })?;

        Ok(TrustHint {
            key: key.clone(),
            trust: computation.trust,
            status: computation.status,
            trials: state.evidence.n,
            successes: state.evidence.k,
            is_drifting: computation.breakdown.is_drifting,
            breakdown: computation.breakdown,
        })
    }

    pub fn hints(&self, keys: &[EntityKey], now: i64) -> Result<Vec<TrustHint>, MedhaError> {
        let mut results = Vec::with_capacity(keys.len());
        for k in keys {
            results.push(self.hint(k, now)?);
        }
        Ok(results)
    }

    pub fn show(&self, key: &EntityKey, now: i64) -> Result<ShowReport, MedhaError> {
        let state_opt = self.store.get(key)?;
        let known = state_opt.is_some();
        let hint = self.hint(key, now)?;

        let all_eps = self.store.episodes(None, None)?;
        let key_str = key.to_string_repr();
        let mut recent_episodes: Vec<Episode> = all_eps
            .into_iter()
            .filter(|e| e.key.to_string_repr() == key_str)
            .collect();
        recent_episodes.reverse();
        recent_episodes.truncate(10);

        Ok(ShowReport {
            key: key.clone(),
            known,
            hint,
            recent_episodes,
        })
    }

    pub fn explain_threshold(
        &self,
        key: &EntityKey,
        now: i64,
    ) -> Result<ThresholdExplanation, MedhaError> {
        let state = self
            .store
            .get(key)?
            .unwrap_or_else(|| fresh_state(key.clone()));
        let hint = self.hint(key, now)?;

        let is_guarded = !state.guard.kind.is_empty() && state.guard.kind != "none";
        let guard_passed = state.guard.last_ok == Some(true);
        let trials_u64 = state.evidence.n.round() as u64;

        // 1. Trusted Gate
        let t_cond1 = hint.trust >= TRUSTED_THRESHOLD;
        let t_cond2 = trials_u64 >= MIN_USES_FOR_TRUSTED;
        let t_cond3 = is_guarded && guard_passed;
        let trusted_met = t_cond1 && t_cond2 && t_cond3;

        let trusted_gate = GateExplanation {
            name: "trusted".to_string(),
            met: trusted_met,
            conditions: vec![
                ConditionStatus {
                    label: format!("trust {:.3} >= {:.2}", hint.trust, TRUSTED_THRESHOLD),
                    met: t_cond1,
                },
                ConditionStatus {
                    label: format!("uses {} >= {}", trials_u64, MIN_USES_FOR_TRUSTED),
                    met: t_cond2,
                },
                ConditionStatus {
                    label: format!("guard passed ({})", if guard_passed { "yes" } else { "no" }),
                    met: t_cond3,
                },
            ],
        };

        // 2. Active Gate
        let a_cond1 = hint.trust >= ACTIVE_THRESHOLD;
        let active_gate = GateExplanation {
            name: "active".to_string(),
            met: a_cond1,
            conditions: vec![ConditionStatus {
                label: format!("trust {:.3} >= {:.2}", hint.trust, ACTIVE_THRESHOLD),
                met: a_cond1,
            }],
        };

        // 3. Retired Gate
        let r_cond1 = trials_u64 >= MIN_USES_FOR_RETIRED;
        let l_times_g = hint.breakdown.wilson_lower * hint.breakdown.guard_factor;
        let r_cond2 = l_times_g < RETIRED_TRUST_THRESHOLD;
        let retired_met = r_cond1 && r_cond2;

        let retired_gate = GateExplanation {
            name: "retired".to_string(),
            met: retired_met,
            conditions: vec![
                ConditionStatus {
                    label: format!("uses {} >= {}", trials_u64, MIN_USES_FOR_RETIRED),
                    met: r_cond1,
                },
                ConditionStatus {
                    label: format!(
                        "undecayed L*G {:.3} < {:.2}",
                        l_times_g, RETIRED_TRUST_THRESHOLD
                    ),
                    met: r_cond2,
                },
            ],
        };

        Ok(ThresholdExplanation {
            key: key.clone(),
            hint,
            gates: vec![trusted_gate, active_gate, retired_gate],
        })
    }

    pub fn simulate(
        &self,
        key: &EntityKey,
        signal_name: &str,
        now: i64,
    ) -> Result<SimulationReport, MedhaError> {
        let spec =
            self.signals
                .get(signal_name)
                .cloned()
                .ok_or_else(|| MedhaError::InvalidArgument {
                    name: "signal",
                    reason: format!("Unknown signal '{}'", signal_name),
                })?;

        let previous_hint = self.hint(key, now)?;

        let current_state = self
            .store
            .get(key)?
            .unwrap_or_else(|| fresh_state(key.clone()));

        // Simulate episode
        let sim_episode = Episode {
            seq: 999_999,
            key: key.clone(),
            at: now,
            author: None,
            payload: EpisodePayload::Signal {
                spec,
                anchors: None,
                ensure: true,
                run_ref: None,
                note: None,
                updater: None,
                weight: None,
                case_id: None,
            },
        };

        let next_state = fold_episode_into_state(Some(current_state), &sim_episode)
            .unwrap_or_else(|| fresh_state(key.clone()));

        let thresholds = Thresholds::default();
        let recency_config = RecencyConfig::default();

        let computation = compute_trust_and_status(TrustComputationInput {
            evidence: &next_state.evidence,
            guard: &next_state.guard,
            distinct_anchor_count: next_state.anchors.len(),
            ema: &next_state.ema,
            last_signal_at: next_state.last_signal_at,
            now,
            stored_status: next_state.status,
            status_override: next_state.status_override,
            thresholds: &thresholds,
            recency_config: &recency_config,
        })?;

        let projected_trust = computation.trust;
        let projected_status = computation.status;
        let trust_delta = round6(projected_trust - previous_hint.trust)?;

        Ok(SimulationReport {
            key: key.clone(),
            signal: signal_name.to_string(),
            previous_trust: previous_hint.trust,
            projected_trust,
            trust_delta,
            previous_status: previous_hint.status,
            projected_status,
            status_changed: previous_hint.status != projected_status,
        })
    }

    // --- WRITE PLANE ---

    pub fn record(&mut self, input: RecordInput) -> Result<AppendResult, MedhaError> {
        let spec = self.signals.get(&input.signal).cloned().ok_or_else(|| {
            MedhaError::InvalidArgument {
                name: "signal",
                reason: format!("Unknown signal '{}'", input.signal),
            }
        })?;

        let episode_input = EpisodeInput {
            key: input.key,
            at: input.at,
            author: input.author,
            payload: EpisodePayload::Signal {
                spec,
                anchors: input.anchors,
                ensure: true,
                run_ref: input.run_ref,
                note: input.note,
                updater: None,
                weight: None,
                case_id: input.case_id,
            },
        };

        Ok(self.store.append(episode_input)?)
    }

    pub fn guard(&mut self, input: GuardInput) -> Result<AppendResult, MedhaError> {
        let episode_input = EpisodeInput {
            key: input.key,
            at: input.at,
            author: input.author,
            payload: EpisodePayload::Guard {
                ok: input.ok,
                kind: input.kind,
                ensure: true,
                note: input.note,
            },
        };

        Ok(self.store.append(episode_input)?)
    }

    pub fn override_status(
        &mut self,
        key: &EntityKey,
        status: LifecycleStatus,
        reason: &str,
        at: i64,
    ) -> Result<AppendResult, MedhaError> {
        let override_type = match status {
            LifecycleStatus::Retired => "retired".to_string(),
            LifecycleStatus::Quarantined => "quarantined".to_string(),
            _ => "restore".to_string(),
        };

        let episode_input = EpisodeInput {
            key: key.clone(),
            at,
            author: None,
            payload: EpisodePayload::Override {
                override_type,
                reason: reason.to_string(),
            },
        };

        Ok(self.store.append(episode_input)?)
    }

    pub fn retract(&mut self, seq: u64, reason: &str, at: i64) -> Result<AppendResult, MedhaError> {
        let all_eps = self.store.episodes(None, None)?;
        let target = all_eps
            .iter()
            .find(|e| e.seq == seq)
            .ok_or_else(|| MedhaError::NotFound(format!("Episode with sequence {}", seq)))?;

        let episode_input = EpisodeInput {
            key: target.key.clone(),
            at,
            author: None,
            payload: EpisodePayload::Retract {
                target_seq: seq,
                reason: reason.to_string(),
            },
        };

        Ok(self.store.append(episode_input)?)
    }

    pub fn propose(
        &mut self,
        key: &EntityKey,
        provenance: &str,
        theta0: Option<f64>,
        description: Option<String>,
        at: i64,
    ) -> Result<AppendResult, MedhaError> {
        let episode_input = EpisodeInput {
            key: key.clone(),
            at,
            author: None,
            payload: EpisodePayload::Proposal {
                provenance: provenance.to_string(),
                theta0,
                description,
                note: None,
            },
        };

        Ok(self.store.append(episode_input)?)
    }

    pub fn define(
        &mut self,
        key: &EntityKey,
        title: Option<String>,
        description: Option<String>,
        tags: Option<Vec<String>>,
        rationale: Option<String>,
        at: i64,
    ) -> Result<AppendResult, MedhaError> {
        let episode_input = EpisodeInput {
            key: key.clone(),
            at,
            author: None,
            payload: EpisodePayload::Define {
                title,
                description,
                tags,
                rationale,
            },
        };

        Ok(self.store.append(episode_input)?)
    }

    pub fn decision(
        &mut self,
        key: &EntityKey,
        case_id: &str,
        parent_id: Option<String>,
        condition: &str,
        decision: Decision,
        at: i64,
    ) -> Result<AppendResult, MedhaError> {
        let episode_input = EpisodeInput {
            key: key.clone(),
            at,
            author: None,
            payload: EpisodePayload::Decision {
                case_id: case_id.to_string(),
                parent_id,
                condition: condition.to_string(),
                decision,
            },
        };

        Ok(self.store.append(episode_input)?)
    }

    // --- MAINTENANCE PLANE ---

    pub fn sweep(&mut self, options: SweepOptions, now: i64) -> Result<SweepReport, MedhaError> {
        let entities = self.store.list()?;
        let mut changes = Vec::new();

        for ent in entities {
            let hint = self.hint(&ent.key, now)?;
            if options.prune_retired && hint.status == LifecycleStatus::Retired {
                let prev = ent.status;
                let ep = EpisodeInput {
                    key: ent.key.clone(),
                    at: now,
                    author: None,
                    payload: EpisodePayload::Sweep {
                        action: "purge".to_string(),
                        reason: "Pruning retired entity".to_string(),
                    },
                };
                self.store.append(ep)?;
                changes.push(SweepChange {
                    key: ent.key.to_string_repr(),
                    previous_status: prev,
                    new_status: LifecycleStatus::Retired,
                    reason: "Purged retired entity".to_string(),
                });
            }
        }

        let swept_count = changes.len();
        Ok(SweepReport {
            swept_count,
            changes,
        })
    }

    pub fn compact(&mut self, _now: i64) -> Result<CompactionReport, MedhaError> {
        let eps = self.store.episodes(None, None)?;
        let before_count = eps.len();

        // Baseline compaction of historical states
        let states = self.store.list()?;
        let mut new_eps = Vec::new();

        for (seq, s) in states.into_iter().enumerate() {
            new_eps.push(Episode {
                seq: seq as u64,
                key: s.key.clone(),
                at: s.last_signal_at.unwrap_or(0),
                author: None,
                payload: EpisodePayload::Baseline { state: s },
            });
        }

        let after_count = new_eps.len();
        self.store.replace_log(&new_eps)?;
        self.store.rebuild()?;

        Ok(CompactionReport {
            before_count,
            after_count,
            removed_count: before_count.saturating_sub(after_count),
        })
    }

    pub fn preflight(&self) -> Result<PreflightReport, MedhaError> {
        let entities = self.store.list()?;
        let episodes = self.store.episodes(None, None)?;

        let mut issues = Vec::new();
        let mut corrupt_seq = None;

        // Check sequence continuity
        for (idx, ep) in episodes.iter().enumerate() {
            if ep.seq != idx as u64 {
                corrupt_seq = Some(ep.seq);
                issues.push(format!(
                    "Non-monotonic sequence gap: expected {}, found {}",
                    idx, ep.seq
                ));
                break;
            }
        }

        let ok = issues.is_empty();
        Ok(PreflightReport {
            ok,
            total_entities: entities.len(),
            total_episodes: episodes.len(),
            corrupt_seq,
            issues,
        })
    }

    // --- SYNC PLANE ---

    pub fn sync_status(&self) -> Result<SyncStatus, MedhaError> {
        Ok(self.sync.status()?)
    }

    pub fn sync_pull(&mut self) -> Result<PullResult, MedhaError> {
        Ok(self.sync.pull()?)
    }

    pub fn sync_push(&mut self, now: Option<i64>) -> Result<PushResult, MedhaError> {
        Ok(self.sync.push(now)?)
    }

    pub fn sync_reconcile(&mut self, now: Option<i64>) -> Result<ReconcileResult, MedhaError> {
        Ok(self.sync.reconcile(now)?)
    }
}
