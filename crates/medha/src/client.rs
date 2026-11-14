//! Medha Rust Client SDK: ergonomic builder and client interfaces for embedding
//! the evidential-memory engine, agent feedback recording, prompt packing,
//! context-aware hints, and gate evaluation.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::config::MedhaConfig;
use crate::engine::{
    EnginePackOptions, GateExplanation, GuardInput, MedhaEngine, RecordInput, ShowReport,
};
use crate::errors::MedhaError;
use crate::maintenance::PreflightReport;
use medha_core::packer::PackOutcome;
use medha_core::round::round6;
use medha_core::types::{EntityKey, LifecycleStatus, TrustHint};
use medha_store::types::{ContextTargets, EntityDefinition, EntityState, EpisodePayload};
use medha_store::{MemoryStore, SqliteStore, StorePort};
use serde::{Deserialize, Serialize};

/// Aggregated store and health status report for clients.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClientStatusReport {
    pub initialized: bool,
    pub total_entities: usize,
    pub total_episodes: usize,
    pub active_count: usize,
    pub probation_count: usize,
    pub trusted_count: usize,
    pub quarantined_count: usize,
    pub retired_count: usize,
    pub drift_count: usize,
    pub preflight: PreflightReport,
}

fn current_timestamp_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn normalize_signal_name(signal: &str) -> String {
    let clean = signal.trim().to_uppercase().replace(['-', ' '], "_");
    match clean.as_str() {
        "RULE_APPLIED" | "HINT_ACCEPTED" | "APPLIED" | "ACCEPT" | "ACCEPTED" => {
            "APPLY".to_string()
        }
        "RULE_REJECTED" | "HINT_REJECTED" | "REJECTED" | "REJECT" => "REJECT_RULE".to_string(),
        "REJECT_CONTEXT" => "REJECT_CONTEXT".to_string(),
        "SKIP" | "SKIPPED" => "SKIP".to_string(),
        other => other.to_string(),
    }
}

/// The high-level client for embedding Medha into Rust applications and agents.
pub struct MedhaClient<S: StorePort> {
    engine: MedhaEngine<S>,
    default_actor: Option<String>,
}

impl MedhaClient<MemoryStore> {
    /// Initialize an ephemeral in-memory client. Ideal for testing, scratchpads, and single-run agents.
    pub fn in_memory() -> Result<Self, MedhaError> {
        let engine = MedhaEngine::open_in_memory()?;
        Ok(Self {
            engine,
            default_actor: None,
        })
    }
}

impl MedhaClient<SqliteStore> {
    /// Open a persistent SQLite client from a database path.
    pub fn open(db_path: impl Into<String>) -> Result<Self, MedhaError> {
        let engine = MedhaEngine::open_sqlite(db_path)?;
        Ok(Self {
            engine,
            default_actor: None,
        })
    }

    /// Open a persistent SQLite client with sync support.
    pub fn open_with_sync(
        db_path: impl Into<String>,
        home_dir: impl AsRef<Path>,
    ) -> Result<Self, MedhaError> {
        let engine = MedhaEngine::open_sqlite_with_sync(db_path, home_dir)?;
        Ok(Self {
            engine,
            default_actor: None,
        })
    }

    /// Discover `.medha/config.json` starting at `start_dir` and walking upwards, opening the configured store.
    pub fn discover(start_dir: impl AsRef<Path>) -> Result<Self, MedhaError> {
        let home = MedhaConfig::find_home(start_dir).ok_or_else(|| {
            MedhaError::InvalidArgument {
                name: "start_dir",
                reason: "No Medha store found at or above path".to_string(),
            }
        })?;
        let config_file = home.join("config.json");
        let config = MedhaConfig::load_from_file(&config_file)?;
        let db_file = config.path.unwrap_or_else(|| "store.sqlite".to_string());
        let full_db_path = if Path::new(&db_file).is_absolute() {
            PathBuf::from(db_file)
        } else {
            home.join(db_file)
        };

        Self::open_with_sync(full_db_path.to_string_lossy(), &home)
    }
}

impl<S: StorePort> MedhaClient<S> {
    /// Construct a client wrapping an existing `MedhaEngine`.
    pub fn from_engine(engine: MedhaEngine<S>) -> Self {
        Self {
            engine,
            default_actor: None,
        }
    }

    /// Create a fluent builder for configuring a MedhaClient.
    pub fn builder() -> MedhaClientBuilder {
        MedhaClientBuilder::new()
    }

    /// Set default actor/author for recorded episodes and signals.
    pub fn with_actor(mut self, actor: impl Into<String>) -> Self {
        self.default_actor = Some(actor.into());
        self
    }

    /// Returns the default actor identifier, if configured.
    pub fn default_actor(&self) -> Option<&str> {
        self.default_actor.as_deref()
    }

    /// Returns a reference to the underlying engine.
    pub fn engine(&self) -> &MedhaEngine<S> {
        &self.engine
    }

    /// Returns a mutable reference to the underlying engine.
    pub fn engine_mut(&mut self) -> &mut MedhaEngine<S> {
        &mut self.engine
    }

    /// Current timestamp in milliseconds.
    pub fn now(&self) -> i64 {
        current_timestamp_ms()
    }

    /// Attach a formal definition to an entity key.
    pub fn define(
        &mut self,
        key: &EntityKey,
        definition: EntityDefinition,
    ) -> Result<(), MedhaError> {
        let at = self.now();
        self.engine.define_entity(key, definition, at)?;
        Ok(())
    }

    /// Helper to define a rule pattern and initialize it in the store on probation.
    pub fn define_rule(
        &mut self,
        id: &str,
        pattern: &str,
        description: Option<&str>,
        namespace: Option<&str>,
        context_targets: Option<ContextTargets>,
    ) -> Result<EntityKey, MedhaError> {
        let key = EntityKey::new(namespace.unwrap_or(""), "rule", id);
        let definition = EntityDefinition {
            title: id.to_string(),
            rationale: description.unwrap_or(pattern).to_string(),
            tags: None,
            context_targets,
        };
        self.define(&key, definition)?;
        self.record_acceptance(&key, Some("Initial rule definition"))?;
        Ok(key)
    }

    /// Get an entity state by key.
    pub fn get(&self, key: &EntityKey) -> Result<Option<EntityState>, MedhaError> {
        self.engine.get(key)
    }

    /// Inspect an entity's trust score, status, thresholds, and evidence breakdown.
    pub fn show(&self, key: &EntityKey) -> Result<ShowReport, MedhaError> {
        self.engine.show(key, self.now())
    }

    /// List all entity states in the store.
    pub fn list(&self) -> Result<Vec<EntityState>, MedhaError> {
        self.engine.list()
    }

    /// Record an empirical signal into memory.
    pub fn record_signal(
        &mut self,
        key: &EntityKey,
        signal: &str,
        note: Option<&str>,
    ) -> Result<TrustHint, MedhaError> {
        let now = self.now();
        let normalized = normalize_signal_name(signal);
        let input = RecordInput {
            key: key.clone(),
            signal: normalized,
            at: now,
            ensure: true,
            author: self.default_actor.clone(),
            anchors: None,
            run_ref: None,
            note: note.map(Into::into),
            case_id: None,
        };
        self.engine.record(input)?;
        self.engine.hint(key, now)
    }

    /// Record positive empirical feedback: an agent applied or followed the entity.
    pub fn record_acceptance(
        &mut self,
        key: &EntityKey,
        note: Option<&str>,
    ) -> Result<TrustHint, MedhaError> {
        self.record_signal(key, "APPLY", note)
    }

    /// Record negative empirical feedback: an agent or user rejected the entity.
    pub fn record_rejection(
        &mut self,
        key: &EntityKey,
        note: Option<&str>,
    ) -> Result<TrustHint, MedhaError> {
        self.record_signal(key, "REJECT_RULE", note)
    }

    /// Record an automated test or check guard outcome into evidential memory.
    pub fn record_guard(&mut self, mut input: GuardInput) -> Result<TrustHint, MedhaError> {
        let now = self.now();
        if input.at == 0 {
            input.at = now;
        }
        if input.author.is_none() {
            input.author = self.default_actor.clone();
        }
        let key = input.key.clone();
        self.engine.guard(input)?;
        self.engine.hint(&key, now)
    }

    /// Retrieve a deterministic evidential pack of entities fitting within a token budget.
    pub fn pack(&self, options: EnginePackOptions) -> Result<PackOutcome, MedhaError> {
        self.engine.pack(options, self.now())
    }

    /// Retrieve evidential context formatted as a markdown prompt section ready to inject into LLMs.
    pub fn pack_prompt(&self, budget: usize) -> Result<String, MedhaError> {
        let outcome = self.pack(EnginePackOptions {
            budget,
            ..Default::default()
        })?;

        if outcome.selected.is_empty() {
            return Ok(String::new());
        }

        let mut lines = Vec::new();
        lines.push("### Evidential Memory & Guiding Rules".to_string());
        lines.push("The following guiding patterns and rules have empirical backing:".to_string());

        for item in outcome.selected {
            let ns = if item.key.namespace.is_empty() {
                String::new()
            } else {
                format!("{}/", item.key.namespace)
            };
            let key_str = format!("{}:{}{}", item.key.kind, ns, item.key.id);
            let trust_str = format!(
                "trust: {:.2}, status: {:?}",
                round6(item.hint.trust).unwrap_or(item.hint.trust),
                item.hint.status
            );
            lines.push(format!("- [{}] ({})", key_str, trust_str));
        }

        Ok(lines.join("\n"))
    }

    /// Query rules and hints matching context targets (active files, languages, keywords).
    pub fn hints_for_context(
        &self,
        files: &[String],
        languages: &[String],
        keywords: &[String],
    ) -> Result<Vec<TrustHint>, MedhaError> {
        let now = self.now();
        let episodes = self.engine.store().episodes(None, None)?;
        let mut defs: HashMap<EntityKey, EntityDefinition> = HashMap::new();

        for ep in episodes {
            if let EpisodePayload::Define { definition } = ep.payload {
                defs.insert(ep.key, definition);
            }
        }

        let states = self.engine.list()?;
        let mut matching_hints = Vec::new();

        for state in states {
            let matched = if let Some(def) = defs.get(&state.key) {
                if let Some(ref targets) = def.context_targets {
                    let mut is_match = false;
                    if let Some(ref target_files) = targets.files {
                        if !target_files.is_empty() && !files.is_empty() {
                            for tf in target_files {
                                for f in files {
                                    if f == tf || f.contains(tf) || tf.contains(f) {
                                        is_match = true;
                                        break;
                                    }
                                }
                                if is_match {
                                    break;
                                }
                            }
                        }
                    }
                    if !is_match {
                        if let Some(ref target_langs) = targets.languages {
                            if !target_langs.is_empty() && !languages.is_empty() {
                                for tl in target_langs {
                                    for l in languages {
                                        if tl.eq_ignore_ascii_case(l) {
                                            is_match = true;
                                            break;
                                        }
                                    }
                                    if is_match {
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    if !is_match {
                        if let Some(ref target_kws) = targets.keywords {
                            if !target_kws.is_empty() && !keywords.is_empty() {
                                for tkw in target_kws {
                                    for kw in keywords {
                                        if kw.to_lowercase().contains(&tkw.to_lowercase()) {
                                            is_match = true;
                                            break;
                                        }
                                    }
                                    if is_match {
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    is_match
                } else {
                    true
                }
            } else {
                true
            };

            if matched {
                matching_hints.push(self.engine.hint(&state.key, now)?);
            }
        }

        Ok(matching_hints)
    }

    /// Evaluate convergence gates for an entity.
    pub fn evaluate_gates(
        &self,
        key: &EntityKey,
    ) -> Result<Option<Vec<GateExplanation>>, MedhaError> {
        let explanation = self.engine.explain_threshold(key, self.now())?;
        Ok(Some(explanation.gates))
    }

    /// Aggregate overall store status, health, and distribution.
    pub fn status(&self) -> Result<ClientStatusReport, MedhaError> {
        let now = self.now();
        let preflight = self.engine.preflight()?;
        let states = self.engine.list()?;

        let mut active_count = 0;
        let mut probation_count = 0;
        let mut trusted_count = 0;
        let mut quarantined_count = 0;
        let mut retired_count = 0;
        let mut drift_count = 0;

        for state in &states {
            let hint = self.engine.hint(&state.key, now)?;
            match hint.status {
                LifecycleStatus::Active => active_count += 1,
                LifecycleStatus::Probation => probation_count += 1,
                LifecycleStatus::Trusted => trusted_count += 1,
                LifecycleStatus::Quarantined => quarantined_count += 1,
                LifecycleStatus::Retired => retired_count += 1,
            }
            if hint.is_drifting {
                drift_count += 1;
            }
        }

        Ok(ClientStatusReport {
            initialized: preflight.ok,
            total_entities: states.len(),
            total_episodes: preflight.total_episodes,
            active_count,
            probation_count,
            trusted_count,
            quarantined_count,
            retired_count,
            drift_count,
            preflight,
        })
    }

    /// Create an agent-scoped session client.
    pub fn session<'a>(&'a mut self, agent_id: &str) -> AgentSession<'a, S> {
        AgentSession {
            client: self,
            agent_id: agent_id.to_string(),
            run_ref: None,
        }
    }
}

/// AgentSession: Scoped agent workflow client.
/// Automatically attaches agent authorship and run references to recorded actions.
pub struct AgentSession<'a, S: StorePort> {
    client: &'a mut MedhaClient<S>,
    agent_id: String,
    run_ref: Option<String>,
}

impl<'a, S: StorePort> AgentSession<'a, S> {
    /// Attach an execution run reference to this session.
    pub fn with_run_ref(mut self, run_ref: impl Into<String>) -> Self {
        self.run_ref = Some(run_ref.into());
        self
    }

    /// Record positive feedback under this agent's identity.
    pub fn accept(
        &mut self,
        key: &EntityKey,
        note: Option<&str>,
    ) -> Result<TrustHint, MedhaError> {
        let now = self.client.now();
        let input = RecordInput {
            key: key.clone(),
            signal: "APPLY".to_string(),
            at: now,
            ensure: true,
            author: Some(self.agent_id.clone()),
            anchors: None,
            run_ref: self.run_ref.clone(),
            note: note.map(Into::into),
            case_id: None,
        };
        self.client.engine.record(input)?;
        self.client.engine.hint(key, now)
    }

    /// Record rejection feedback under this agent's identity.
    pub fn reject(
        &mut self,
        key: &EntityKey,
        note: Option<&str>,
    ) -> Result<TrustHint, MedhaError> {
        let now = self.client.now();
        let input = RecordInput {
            key: key.clone(),
            signal: "REJECT_RULE".to_string(),
            at: now,
            ensure: true,
            author: Some(self.agent_id.clone()),
            anchors: None,
            run_ref: self.run_ref.clone(),
            note: note.map(Into::into),
            case_id: None,
        };
        self.client.engine.record(input)?;
        self.client.engine.hint(key, now)
    }

    /// Record an arbitrary empirical signal under this agent's identity.
    pub fn record_signal(
        &mut self,
        key: &EntityKey,
        signal: &str,
        note: Option<&str>,
    ) -> Result<TrustHint, MedhaError> {
        let now = self.client.now();
        let normalized = normalize_signal_name(signal);
        let input = RecordInput {
            key: key.clone(),
            signal: normalized,
            at: now,
            ensure: true,
            author: Some(self.agent_id.clone()),
            anchors: None,
            run_ref: self.run_ref.clone(),
            note: note.map(Into::into),
            case_id: None,
        };
        self.client.engine.record(input)?;
        self.client.engine.hint(key, now)
    }

    /// Record a guard check outcome under this agent's identity.
    pub fn record_guard(
        &mut self,
        guard_name: &str,
        passed: bool,
        key: Option<&EntityKey>,
        note: Option<&str>,
    ) -> Result<TrustHint, MedhaError> {
        let fallback_key = EntityKey::new("", "rule", guard_name);
        let target_key = key.unwrap_or(&fallback_key);
        let input = GuardInput {
            key: target_key.clone(),
            kind: Some(guard_name.to_string()),
            ok: passed,
            at: self.client.now(),
            author: Some(self.agent_id.clone()),
            note: note.map(Into::into),
        };
        self.client.record_guard(input)
    }

    /// Query hints matching active context targets.
    pub fn hints_for_context(
        &self,
        files: &[String],
        languages: &[String],
        keywords: &[String],
    ) -> Result<Vec<TrustHint>, MedhaError> {
        self.client.hints_for_context(files, languages, keywords)
    }

    /// Retrieve an evidential pack fitting within a token budget.
    pub fn pack(&self, budget: usize) -> Result<PackOutcome, MedhaError> {
        self.client.pack(EnginePackOptions {
            budget,
            ..Default::default()
        })
    }

    /// Retrieve evidential context formatted as a markdown prompt section.
    pub fn pack_prompt(&self, budget: usize) -> Result<String, MedhaError> {
        self.client.pack_prompt(budget)
    }
}

/// Fluent builder for constructing `MedhaClient` instances.
#[derive(Debug, Default)]
pub struct MedhaClientBuilder {
    actor: Option<String>,
}

impl MedhaClientBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_actor(mut self, actor: impl Into<String>) -> Self {
        self.actor = Some(actor.into());
        self
    }

    pub fn build_in_memory(self) -> Result<MedhaClient<MemoryStore>, MedhaError> {
        let mut client = MedhaClient::in_memory()?;
        if let Some(actor) = self.actor {
            client = client.with_actor(actor);
        }
        Ok(client)
    }

    pub fn build_sqlite(
        self,
        db_path: impl Into<String>,
    ) -> Result<MedhaClient<SqliteStore>, MedhaError> {
        let mut client = MedhaClient::open(db_path)?;
        if let Some(actor) = self.actor {
            client = client.with_actor(actor);
        }
        Ok(client)
    }
}
