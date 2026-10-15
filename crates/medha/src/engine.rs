use std::collections::HashMap;

use crate::config::MedhaConfig;
use crate::errors::MedhaError;
use crate::maintenance::{
    CompactionReport, PreflightReport, SweepChange, SweepOptions, SweepReport,
};
use medha_core::decision::Decision;
use medha_core::drift::ema_step;
use medha_core::formula::{compute_trust_and_status, TrustComputationInput};
use medha_core::packer::{
    pack_entities, PackCandidate, PackOutcome, PackPolicy, DEFAULT_EXPLORATION_RATIO,
};
use medha_core::round::round6;
use medha_core::thresholds::DEFAULT_EMA_ALPHA;
use medha_core::thresholds::{
    ACTIVE_THRESHOLD, MIN_USES_FOR_RETIRED, MIN_USES_FOR_TRUSTED, RETIRED_TRUST_THRESHOLD,
    TRUSTED_THRESHOLD,
};
use medha_core::types::{
    Anchor, EntityKey, LifecycleStatus, RecencyConfig, SignalSpec, Thresholds, TrustHint,
};
use medha_store::folding::{
    durability_anchor_count, fold_episode_into_state, fresh_state, fresh_state_at,
};
use medha_store::types::EntityState;
use medha_store::{
    AppendResult, EntityDefinition, Episode, EpisodeInput, EpisodePayload, MemoryStore, OpenResult,
    SqliteStore, SqliteStoreOptions, StoreError, StorePort, StoreRegistries,
};
use medha_sync::{
    FileSyncAdapter, GitRefSyncAdapter, NoopSyncAdapter, PullResult, PushResult, ReconcileResult,
    SyncPort, SyncStatus,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EnginePackOptions {
    pub budget: usize,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub namespace: Option<String>,
    /// Only these entity ids (gh-23), so a host's own rule set stays authoritative.
    #[serde(default)]
    pub ids: Option<Vec<String>>,
    #[serde(default = "default_pack_exploration_ratio")]
    pub exploration_ratio: f64,
    #[serde(default)]
    pub seed: Option<u64>,
    #[serde(default)]
    pub min_trust: f64,
    #[serde(default)]
    pub allow_quarantined: bool,
    #[serde(default)]
    pub allow_retired: bool,
}

fn default_pack_exploration_ratio() -> f64 {
    DEFAULT_EXPLORATION_RATIO
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecordInput {
    pub key: EntityKey,
    pub signal: String,
    pub at: i64,
    /// Create the entity if it is unknown. Without it a signal for an unknown entity is still
    /// logged, but the fold gives it no effect (spec §5.2), as the TypeScript engine does.
    #[serde(default)]
    pub ensure: bool,
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
    /// Set while the status holds whatever new evidence says (medha-x3g).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latch: Option<StatusLatch>,
}

/// A status that new evidence cannot change, and the episode that set it (medha-x3g): a stored
/// `retired` (spec §6 step 2) or an override `quarantined` (step 1). Same shape as the TypeScript
/// engine's `StatusLatch`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusLatch {
    pub status: LifecycleStatus,
    pub seq: u64,
    pub at: i64,
    /// `evidence` when the fold retired it; otherwise the episode type that did.
    pub cause: String,
    pub evidence: LatchEvidence,
    /// `restore`, and for `evidence` also `retract`.
    pub lifted_by: Vec<String>,
}

/// What a retraction did to the entity's status (gh-22).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RetractOutcome {
    #[serde(flatten)]
    pub appended: AppendResult,
    /// Set when the retraction took the entity out of `quarantined` or `retired`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifted: Option<LiftedStatus>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LiftedStatus {
    pub from: LifecycleStatus,
    pub to: LifecycleStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LatchEvidence {
    pub k: f64,
    pub n: f64,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latch: Option<StatusLatch>,
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

pub struct MedhaEngine<S: StorePort> {
    store: S,
    sync: Box<dyn SyncPort>,
    config: MedhaConfig,
    signals: HashMap<String, SignalSpec>,
    kinds: Vec<String>,
    /// How the store opened. A corrupt log is readable only up to the break, so evidence reads
    /// refuse it and `preflight` reports it.
    opened: OpenResult,
}

/// The kinds every store knows, whatever its registries say (as in the TypeScript `KindRegistry`).
const BUILTIN_KINDS: [&str; 3] = ["rule", "recipe", "tool"];

fn builtin_kinds() -> Vec<String> {
    BUILTIN_KINDS.iter().map(|k| k.to_string()).collect()
}

impl MedhaEngine<SqliteStore> {
    pub fn open_sqlite(db_path: impl Into<String>) -> Result<Self, MedhaError> {
        let path = db_path.into();
        let mut store = SqliteStore::new(SqliteStoreOptions {
            path: path.clone(),
            registries: None,
            resilient_replay: false,
        });
        let opened = store.open()?;

        let config = MedhaConfig {
            path: Some(path),
            ..Default::default()
        };

        let signals = medha_core::canonical_signals();

        Ok(Self {
            store,
            sync: Box::new(NoopSyncAdapter),
            config,
            signals,
            kinds: builtin_kinds(),
            opened,
        })
    }

    pub fn open_sqlite_with_sync(
        db_path: impl Into<String>,
        home_dir: impl AsRef<std::path::Path>,
    ) -> Result<Self, MedhaError> {
        let mut engine = Self::open_sqlite(db_path)?;
        let home = home_dir.as_ref();
        let repo_candidate = if home.file_name().map(|n| n == ".medha").unwrap_or(false) {
            home.parent().unwrap_or(home)
        } else {
            home
        };
        let git_adapter = GitRefSyncAdapter::new(repo_candidate);
        if git_adapter.is_git_repo() {
            engine.sync = Box::new(git_adapter);
        } else {
            let direct_adapter = GitRefSyncAdapter::new(home);
            if direct_adapter.is_git_repo() {
                engine.sync = Box::new(direct_adapter);
            }
        }
        Ok(engine)
    }
}

impl MedhaEngine<MemoryStore> {
    pub fn open_in_memory() -> Result<Self, MedhaError> {
        let mut store = MemoryStore::new(None);
        let opened = store.open()?;

        let config = MedhaConfig {
            backend: crate::config::BackendKind::Memory,
            path: None,
            ..Default::default()
        };

        let signals = medha_core::canonical_signals();

        Ok(Self {
            store,
            sync: Box::new(NoopSyncAdapter),
            config,
            signals,
            kinds: builtin_kinds(),
            opened,
        })
    }
}

impl<S: StorePort> MedhaEngine<S> {
    pub fn with_file_sync(
        mut store: S,
        file_path: impl AsRef<std::path::Path>,
        config: MedhaConfig,
    ) -> Self {
        let opened = store.open().unwrap_or(OpenResult::Ok);
        let sync = Box::new(FileSyncAdapter::new(file_path));
        let signals = medha_core::canonical_signals();
        Self {
            store,
            sync,
            config,
            signals,
            kinds: builtin_kinds(),
            opened,
        }
    }

    pub fn with_git_sync(
        mut store: S,
        repo_dir: impl AsRef<std::path::Path>,
        config: MedhaConfig,
    ) -> Self {
        let opened = store.open().unwrap_or(OpenResult::Ok);
        let sync = Box::new(GitRefSyncAdapter::new(repo_dir));
        let signals = medha_core::canonical_signals();
        Self {
            store,
            sync,
            config,
            signals,
            kinds: builtin_kinds(),
            opened,
        }
    }

    pub fn new(store: S, sync: Box<dyn SyncPort>, config: MedhaConfig) -> Self {
        let signals = medha_core::canonical_signals();
        let opened = OpenResult::Ok;
        Self {
            store,
            sync,
            config,
            signals,
            kinds: builtin_kinds(),
            opened,
        }
    }

    pub fn set_sync(&mut self, sync: Box<dyn SyncPort>) {
        self.sync = sync;
    }

    /// Resolve signals and kinds from the store's registries (`config.json`), as the TypeScript
    /// engine does. Both engines open the same store, so a signal or kind it does not declare must
    /// be refused here: written anyway, it makes the TypeScript engine read the store as corrupt.
    pub fn use_registries(&mut self, registries: &StoreRegistries) {
        if !registries.signal_specs.is_empty() {
            self.signals = registries
                .signal_specs
                .iter()
                .map(|spec| (spec.name.clone(), spec.clone()))
                .collect();
        }
        let mut kinds = builtin_kinds();
        for kind in &registries.kinds {
            if !kinds.contains(kind) {
                kinds.push(kind.clone());
            }
        }
        self.kinds = kinds;
    }

    /// Refuse a read that answers from the evidence when the log opened corrupt: the store holds
    /// only the episodes before the break, so the answer would quietly cover part of the evidence
    /// (gh-18). `preflight` reports the break instead.
    fn require_readable(&self) -> Result<(), MedhaError> {
        match &self.opened {
            OpenResult::Ok => Ok(()),
            OpenResult::Corrupt { location } => Err(MedhaError::Store(StoreError::CorruptStore {
                store_path: location.source.clone(),
                at_seq: location.at_seq,
                reason: "the log is unrecoverable from there, so any answer would cover only the \
                         episodes before it; run `medha preflight`, then restore a snapshot"
                    .to_string(),
            })),
        }
    }

    fn require_kind(&self, key: &EntityKey) -> Result<(), MedhaError> {
        if self.kinds.contains(&key.kind) {
            return Ok(());
        }
        Err(MedhaError::InvalidArgument {
            name: "kind",
            reason: format!(
                "Unknown kind '{}' (registered: {})",
                key.kind,
                self.kinds.join(", ")
            ),
        })
    }

    pub fn store(&self) -> &S {
        &self.store
    }

    pub fn store_mut(&mut self) -> &mut S {
        &mut self.store
    }

    pub fn sync(&self) -> &dyn SyncPort {
        self.sync.as_ref()
    }

    pub fn sync_mut(&mut self) -> &mut dyn SyncPort {
        self.sync.as_mut()
    }

    pub fn config(&self) -> &MedhaConfig {
        &self.config
    }

    // --- READ PLANE ---

    pub fn get(&self, key: &EntityKey) -> Result<Option<EntityState>, MedhaError> {
        Ok(self.store.get(key)?)
    }

    pub fn list(&self) -> Result<Vec<EntityState>, MedhaError> {
        self.require_readable()?;
        Ok(self.store.list()?)
    }

    pub fn hint(&self, key: &EntityKey, now: i64) -> Result<TrustHint, MedhaError> {
        self.require_readable()?;
        let state = self
            .store
            .get(key)?
            .unwrap_or_else(|| fresh_state(key.clone()));

        let thresholds = Thresholds::default();
        let recency_config = RecencyConfig::default();

        let computation = compute_trust_and_status(TrustComputationInput {
            evidence: &state.evidence,
            guard: &state.guard,
            distinct_anchor_count: durability_anchor_count(&state),
            ema: &state.ema,
            last_signal_at: state.last_signal_at,
            now,
            stored_status: state.status,
            status_override: state.status_override,
            thresholds: &thresholds,
            recency_config: &recency_config,
            rejecting_authors: None,
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

        let latch = self.latch_of(key)?;
        Ok(ShowReport {
            key: key.clone(),
            known,
            hint,
            recent_episodes,
            latch,
        })
    }

    /// Replays the key's episodes the way the projection does (retractions masked) and reports
    /// the latch still in force, if any. A guard-failure or drift quarantine is not one: it lifts
    /// by itself when the cause clears.
    pub fn latch_of(&self, key: &EntityKey) -> Result<Option<StatusLatch>, MedhaError> {
        let log = self.store.episodes(None, None)?;
        let retracted: std::collections::HashSet<u64> = log
            .iter()
            .filter_map(|e| match &e.payload {
                EpisodePayload::Retract { target_seq, .. } => Some(*target_seq),
                _ => None,
            })
            .collect();
        let key_str = key.to_string_repr();
        let mut state: Option<EntityState> = None;
        let mut latch: Option<StatusLatch> = None;
        for ep in log.iter().filter(|e| e.key.to_string_repr() == key_str) {
            if retracted.contains(&ep.seq) {
                continue;
            }
            let before = state.clone();
            state = fold_episode_into_state(state, ep);
            let Some(now) = &state else {
                latch = None;
                continue;
            };
            let was_retired = before
                .as_ref()
                .is_some_and(|s| s.status == LifecycleStatus::Retired);
            let was_overridden = before
                .as_ref()
                .is_some_and(|s| s.status_override == Some(LifecycleStatus::Quarantined));
            let entered_retired = now.status == LifecycleStatus::Retired && !was_retired;
            let entered_override =
                now.status_override == Some(LifecycleStatus::Quarantined) && !was_overridden;
            if entered_retired || entered_override {
                let cause = match &ep.payload {
                    EpisodePayload::Override { .. } => "override",
                    EpisodePayload::Sweep { .. } => "sweep",
                    EpisodePayload::Baseline { .. } => "baseline",
                    _ => "evidence",
                };
                let mut lifted_by = vec!["restore".to_string()];
                if cause == "evidence" {
                    lifted_by.push("retract".to_string());
                }
                latch = Some(StatusLatch {
                    status: if entered_retired {
                        LifecycleStatus::Retired
                    } else {
                        LifecycleStatus::Quarantined
                    },
                    seq: ep.seq,
                    at: ep.at,
                    cause: cause.to_string(),
                    evidence: LatchEvidence {
                        k: now.evidence.k,
                        n: now.evidence.n,
                    },
                    lifted_by,
                });
            } else if now.status != LifecycleStatus::Retired
                && now.status_override != Some(LifecycleStatus::Quarantined)
            {
                latch = None;
            }
        }
        Ok(latch)
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
            latch: self.latch_of(key)?,
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
            distinct_anchor_count: durability_anchor_count(&next_state),
            ema: &next_state.ema,
            last_signal_at: next_state.last_signal_at,
            now,
            stored_status: next_state.status,
            status_override: next_state.status_override,
            thresholds: &thresholds,
            recency_config: &recency_config,
            rejecting_authors: None,
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
        self.require_kind(&input.key)?;
        let spec = self.signals.get(&input.signal).cloned().ok_or_else(|| {
            MedhaError::InvalidArgument {
                name: "signal",
                reason: format!("Unknown signal '{}'", input.signal),
            }
        })?;

        // Like the TypeScript write plane, the episode carries the weight-updater's result, so the
        // fold applies it as written. Only the `ema` updater exists here; any other name falls
        // back to it, as the TypeScript registry does for an updater it cannot load.
        let base = match self.store.get(&input.key)? {
            Some(state) => Some(state),
            None if input.ensure => Some(fresh_state_at(input.key.clone(), input.at)),
            None => None,
        };
        let weight = match &base {
            Some(state) => Some(ema_step(Some(state.ema.mu), spec.value, DEFAULT_EMA_ALPHA)?),
            None => None,
        };

        let episode_input = EpisodeInput {
            key: input.key,
            at: input.at,
            author: input.author,
            payload: EpisodePayload::Signal {
                spec,
                anchors: input.anchors,
                ensure: input.ensure,
                run_ref: input.run_ref,
                note: input.note,
                updater: weight.map(|_| "ema".to_string()),
                weight,
                case_id: input.case_id,
            },
        };

        Ok(self.store.append(episode_input)?)
    }

    pub fn guard(&mut self, input: GuardInput) -> Result<AppendResult, MedhaError> {
        self.require_kind(&input.key)?;
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
        self.require_kind(key)?;
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
        Ok(self.retract_checked(seq, reason, at, None)?.appended)
    }

    /// Retract an episode; with `expect`, the target must belong to that entity (gh-22: a bare
    /// seq can name another entity's episode). Reports when the retraction takes the entity out
    /// of `quarantined` or `retired`, so the caller can say a latch was lifted.
    pub fn retract_checked(
        &mut self,
        seq: u64,
        reason: &str,
        at: i64,
        expect: Option<&EntityKey>,
    ) -> Result<RetractOutcome, MedhaError> {
        let all_eps = self.store.episodes(None, None)?;
        let target_key = all_eps
            .iter()
            .find(|e| e.seq == seq)
            .map(|e| e.key.clone())
            .ok_or_else(|| MedhaError::NotFound(format!("Episode with sequence {}", seq)))?;
        if let Some(expected) = expect {
            if expected != &target_key {
                return Err(MedhaError::InvalidArgument {
                    name: "seq",
                    reason: format!(
                        "episode #{seq} belongs to {}, not {}; check the seq with `medha show`",
                        target_key.to_string_repr(),
                        expected.to_string_repr()
                    ),
                });
            }
        }
        let before = match self.store.get(&target_key)? {
            Some(_) => Some(self.hint(&target_key, at)?.status),
            None => None,
        };

        let episode_input = EpisodeInput {
            key: target_key.clone(),
            at,
            author: None,
            payload: EpisodePayload::Retract {
                target_seq: seq,
                reason: reason.to_string(),
            },
        };
        let appended = self.store.append(episode_input)?;

        let after = self.hint(&target_key, at)?.status;
        let lifted = match before {
            Some(from @ (LifecycleStatus::Quarantined | LifecycleStatus::Retired))
                if from != after =>
            {
                Some(LiftedStatus { from, to: after })
            }
            _ => None,
        };
        Ok(RetractOutcome { appended, lifted })
    }

    /// Lift a latch (a retirement, or an override quarantine) as a human decision: one audited
    /// `override: restore` episode (gh-22). Refuses an entity that is not latched.
    pub fn reinstate(
        &mut self,
        key: &EntityKey,
        reason: &str,
        at: i64,
    ) -> Result<(StatusLatch, AppendResult), MedhaError> {
        self.require_kind(key)?;
        let latch = self
            .latch_of(key)?
            .ok_or_else(|| MedhaError::InvalidArgument {
                name: "id",
                reason: format!(
                    "{} is not latched (retired, or quarantined by an override); a guard or drift \
                 quarantine lifts by itself when its cause clears",
                    key.to_string_repr()
                ),
            })?;
        let appended = self.override_status(key, LifecycleStatus::Probation, reason, at)?;
        Ok((latch, appended))
    }

    pub fn remove_episode(&mut self, seq: u64) -> Result<(), MedhaError> {
        let episodes = self.store.episodes(None, None)?;
        let mut filtered = Vec::new();
        let mut found = false;
        let mut new_seq = 0;
        for ep in episodes {
            if ep.seq == seq {
                found = true;
                continue;
            }
            let mut updated = ep;
            updated.seq = new_seq;
            new_seq += 1;
            filtered.push(updated);
        }
        if !found {
            return Err(MedhaError::NotFound(format!(
                "Episode with sequence {}",
                seq
            )));
        }
        self.store.replace_log(&filtered)?;
        self.store.rebuild()?;
        Ok(())
    }

    pub fn propose(
        &mut self,
        key: &EntityKey,
        provenance: &str,
        theta0: Option<f64>,
        description: Option<String>,
        at: i64,
    ) -> Result<AppendResult, MedhaError> {
        self.require_kind(key)?;
        let episode_input = EpisodeInput {
            key: key.clone(),
            at,
            author: None,
            payload: EpisodePayload::Proposal {
                provenance: provenance.to_string(),
                theta0,
                description,
                evidence_refs: None,
                anchor: None,
                promoted: None,
                promotion_reason: None,
                note: None,
            },
        };

        Ok(self.store.append(episode_input)?)
    }

    pub fn define(
        &mut self,
        key: &EntityKey,
        title: &str,
        rationale: &str,
        tags: Option<Vec<String>>,
        at: i64,
    ) -> Result<AppendResult, MedhaError> {
        self.require_kind(key)?;
        let episode_input = EpisodeInput {
            key: key.clone(),
            at,
            author: None,
            payload: EpisodePayload::Define {
                definition: EntityDefinition {
                    title: title.to_string(),
                    rationale: rationale.to_string(),
                    tags,
                },
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
        self.require_kind(key)?;
        let episode_input = EpisodeInput {
            key: key.clone(),
            at,
            author: None,
            payload: EpisodePayload::Decision {
                case_id: case_id.to_string(),
                parent_id,
                detach: None,
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

        // The store stops reading at the first episode it cannot accept, so the episodes it hands
        // back are always contiguous: the break is only visible in how it opened.
        if let OpenResult::Corrupt { location } = &self.opened {
            corrupt_seq = Some(location.at_seq);
            issues.push(format!(
                "Log is unrecoverable from seq {}: episodes from there on could not be read",
                location.at_seq
            ));
        }

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

    pub fn pack(&self, options: EnginePackOptions, now: i64) -> Result<PackOutcome, MedhaError> {
        self.require_readable()?;
        let entities = self.store.list()?;
        let mut candidates = Vec::new();
        for state in entities {
            if let Some(ref k) = options.kind {
                if &state.key.kind != k {
                    continue;
                }
            }
            if let Some(ref ns) = options.namespace {
                if &state.key.namespace != ns {
                    continue;
                }
            }
            if let Some(ids) = &options.ids {
                if !ids.iter().any(|id| id == &state.key.id) {
                    continue;
                }
            }
            let hint = self.hint(&state.key, now)?;
            let key_str_len = state.key.to_string_repr().len();
            let cost = std::cmp::max(10, key_str_len.div_ceil(3) + 20);
            candidates.push(PackCandidate {
                key: state.key,
                hint,
                cost,
                mandatory: false,
                payload: None,
            });
        }

        let policy = PackPolicy {
            budget: options.budget,
            exploration_ratio: options.exploration_ratio,
            seed: options.seed,
            min_trust: options.min_trust,
            allow_quarantined: options.allow_quarantined,
            allow_retired: options.allow_retired,
        };

        Ok(pack_entities(&candidates, &policy)?)
    }

    // --- SYNC PLANE ---

    pub fn sync_status(&self) -> Result<SyncStatus, MedhaError> {
        Ok(self.sync.status(&self.store)?)
    }

    pub fn sync_pull(&mut self) -> Result<PullResult, MedhaError> {
        Ok(self.sync.pull(&mut self.store)?)
    }

    pub fn sync_push(&mut self, now: Option<i64>) -> Result<PushResult, MedhaError> {
        Ok(self.sync.push(&self.store, now)?)
    }

    pub fn sync_reconcile(&mut self, now: Option<i64>) -> Result<ReconcileResult, MedhaError> {
        Ok(self.sync.reconcile(&mut self.store, now)?)
    }
}
