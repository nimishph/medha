use std::collections::HashMap;

use crate::config::MedhaConfig;
use crate::errors::MedhaError;
use crate::maintenance::{
    CompactionReport, PreflightReport, SweepChange, SweepOptions, SweepReport, DEFAULT_FOLD_DAYS,
};
use medha_core::decision::Decision;
use medha_core::drift::ema_step;
use medha_core::formula::{compute_trust_and_status, TrustComputationInput};
use medha_core::packer::{
    pack_entities, PackCandidate, PackOutcome, PackPolicy, DEFAULT_EXPLORATION_RATIO,
};
use medha_core::round::round6;
use medha_core::thresholds::DAY_MS;
use medha_core::thresholds::DEFAULT_EMA_ALPHA;
use medha_core::types::{
    Anchor, EntityKey, LifecycleStatus, RecencyConfig, SignalSpec, Thresholds, TrustHint,
};
use medha_store::folding::{
    durability_anchor_count, fold_episode_with_registries, fresh_state, fresh_state_at,
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

impl Default for EnginePackOptions {
    fn default() -> Self {
        Self {
            budget: 2000,
            kind: None,
            namespace: None,
            ids: None,
            exploration_ratio: DEFAULT_EXPLORATION_RATIO,
            seed: None,
            min_trust: 0.0,
            allow_quarantined: false,
            allow_retired: false,
        }
    }
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

/// The built-in weight updaters (TypeScript `BUILTIN_UPDATERS`), by name.
pub const BUILTIN_UPDATERS: [&str; 4] = ["ema", "wilson", "sliding-window", "asymmetric-penalty"];

/// Whether `name` is a built-in updater (`asymmetric` is the alias of `asymmetric-penalty`).
pub fn is_builtin_updater(name: &str) -> bool {
    let n = name.to_lowercase();
    BUILTIN_UPDATERS.contains(&n.as_str()) || n == "asymmetric"
}

fn clamp_round(v: f64) -> Result<f64, MedhaError> {
    Ok(round6(v.clamp(0.0, 1.0))?)
}

/// One weight update from the entity's state, as the TypeScript built-in updaters compute it.
/// Returns the updater actually used and the new weight (clamped to [0, 1], rounded to 6 places).
fn compute_weight(
    name: &str,
    state: &medha_store::EntityState,
    spec: &SignalSpec,
) -> Result<(String, f64), MedhaError> {
    let current = state.ema.mu;
    let initial = state.ema.theta0;
    let samples = state.evidence.n;
    let accepted = state.evidence.k;
    let success = spec.counts_as_trial && spec.counts_as_success;
    let canonical = name.to_lowercase();
    let (used, weight) = match canonical.as_str() {
        "wilson" => {
            let positive = accepted + if success { 1.0 } else { 0.0 };
            let total = samples + 1.0;
            let w = if total < 5.0 {
                round6(0.5 * initial + 0.5 * (positive / total))?
            } else {
                medha_core::wilson::wilson_lower_bound(
                    positive,
                    total,
                    medha_core::thresholds::WILSON_Z,
                )?
            };
            ("wilson", w)
        }
        "sliding-window" => {
            let step = 1.0 / (samples + 1.0).clamp(10.0, 50.0);
            let delta = if success {
                step * (1.0 - current)
            } else if spec.name == "REJECT_CONTEXT" {
                -step * 0.5 * current
            } else if spec.counts_as_trial {
                -step * current
            } else {
                0.0
            };
            ("sliding-window", current + delta)
        }
        "asymmetric-penalty" | "asymmetric" => {
            let delta = if success {
                0.04 * (1.0 - current)
            } else if spec.name == "REJECT_CONTEXT" {
                -0.05 * current
            } else if spec.counts_as_trial {
                -0.25 * current
            } else {
                0.0
            };
            ("asymmetric-penalty", current + delta)
        }
        _ => (
            "ema",
            ema_step(Some(current), spec.value, DEFAULT_EMA_ALPHA)?,
        ),
    };
    Ok((used.to_string(), clamp_round(weight)?))
}

/// The active context a pack is matched against (TypeScript `ContextFilter`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ContextFilter {
    #[serde(default)]
    pub files: Option<Vec<String>>,
    #[serde(default)]
    pub languages: Option<Vec<String>>,
    #[serde(default)]
    pub query: Option<String>,
}

/// A glob as the TypeScript packer reads it: `**` any path, `*` within a segment, case-insensitive.
fn glob_matches(pattern: &str, text: &str) -> bool {
    fn go(p: &[char], t: &[char]) -> bool {
        match p.first() {
            None => t.is_empty(),
            Some('*') if p.get(1) == Some(&'*') => (0..=t.len()).any(|i| go(&p[2..], &t[i..])),
            Some('*') => {
                let mut i = 0;
                loop {
                    if go(&p[1..], &t[i..]) {
                        return true;
                    }
                    if i >= t.len() || t[i] == '/' {
                        return false;
                    }
                    i += 1;
                }
            }
            Some(c) => t.first().is_some_and(|x| x == c) && go(&p[1..], &t[1..]),
        }
    }
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let t: Vec<char> = text.to_lowercase().chars().collect();
    go(&p, &t)
}

/// TypeScript `matchesContextTargets`: no targets (or no filter) match everything; otherwise a
/// file, a language or a query keyword must match.
pub fn matches_context_targets(
    targets: Option<&medha_store::ContextTargets>,
    filter: &ContextFilter,
) -> bool {
    let Some(t) = targets else {
        return true;
    };
    let files = t.files.clone().unwrap_or_default();
    let langs = t.languages.clone().unwrap_or_default();
    let keywords = t.keywords.clone().unwrap_or_default();
    if files.is_empty() && langs.is_empty() && keywords.is_empty() {
        return true;
    }
    if let Some(active) = filter.files.as_ref().filter(|f| !f.is_empty()) {
        for pattern in &files {
            for file in active {
                if file == pattern
                    || file.ends_with(pattern.as_str())
                    || pattern.ends_with(file.as_str())
                    || file.contains(pattern.as_str())
                    || (pattern.contains('*') && glob_matches(pattern, file))
                {
                    return true;
                }
            }
        }
    }
    if let Some(active) = filter.languages.as_ref().filter(|l| !l.is_empty()) {
        let targets: Vec<String> = langs.iter().map(|l| l.to_lowercase()).collect();
        if active.iter().any(|l| targets.contains(&l.to_lowercase())) {
            return true;
        }
    }
    if let Some(q) = &filter.query {
        let q = q.to_lowercase();
        if keywords.iter().any(|k| q.contains(&k.to_lowercase())) {
            return true;
        }
    }
    false
}

/// A trap the negative-evidence radar reports (TypeScript `Pitfall`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pitfall {
    pub key: EntityKey,
    pub status: String,
    pub trials: f64,
    pub successes: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failing_guard: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_note: Option<String>,
    pub reason: String,
}

/// A number as JavaScript prints it in a template string (`5`, not `5.0`).
fn js_number(v: f64) -> String {
    if v.fract() == 0.0 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

/// A decision-tree write (see `MedhaEngine::decision_with`).
#[derive(Debug, Clone, PartialEq)]
pub struct DecisionInput {
    pub key: EntityKey,
    /// An existing branch to edit; `None` mints a new branch id.
    pub case_id: Option<String>,
    pub parent_id: Option<String>,
    pub detach: bool,
    pub condition: String,
    pub decision: Decision,
    pub author: Option<String>,
    pub at: i64,
}

/// The canonical form two conditions are compared in: trimmed, whitespace collapsed, lowercase.
pub fn normalize_condition(condition: &str) -> String {
    condition
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// `<entity-id>-dec-<5 base36 chars>`, salted by the key (TypeScript `newDecisionCaseId`).
fn new_decision_case_id(key: &EntityKey, at: i64) -> String {
    const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let fnv = |input: &str| -> u32 {
        let mut hash: u32 = 0x811c_9dc5;
        for b in input.bytes() {
            hash ^= u32::from(b);
            hash = hash.wrapping_mul(0x0100_0193);
        }
        hash
    };
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let salt = fnv(&format!("{}/{}/{}", key.namespace, key.kind, key.id));
    let mut seed = salt ^ nanos ^ (at as u32);
    let mut suffix = String::new();
    for i in 0..5u32 {
        seed = fnv(&format!("{seed}:{i}"));
        suffix.push(ALPHABET[(seed % ALPHABET.len() as u32) as usize] as char);
    }
    format!("{}-dec-{suffix}", key.id)
}

/// Everything a proposal can carry (the TypeScript `Proposal`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProposeInput {
    pub key: EntityKey,
    pub provenance: String,
    #[serde(default)]
    pub theta0: Option<f64>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub evidence_refs: Option<Vec<String>>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    /// The anchor the proposal was made against (e.g. a commit), when it has one.
    #[serde(default)]
    pub anchor: Option<Anchor>,
    pub at: i64,
}

/// An incident or session retrospective to distil (TypeScript `TrajectoryEvidence`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrajectoryEvidence {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit_sha: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lessons: Option<Vec<TrajectoryLesson>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrajectoryLesson {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

/// A candidate the trajectory distiller proposes (the TypeScript `Proposal` it mines).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DistilledProposal {
    pub key: EntityKey,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor: Option<Anchor>,
    pub provenance: String,
    pub theta0: f64,
    pub author: String,
    pub note: String,
}

/// The TypeScript `TrajectoryDistillerMiner`: one probation candidate per lesson (kind from the
/// lesson, default `rule`), or one `recipe` from the incident itself when it has no lessons; all
/// anchored to the commit when there is one, at theta0 0.35.
pub fn distill_proposals(item: &TrajectoryEvidence) -> Vec<DistilledProposal> {
    if item.id.is_empty() {
        return Vec::new();
    }
    let anchor = item.commit_sha.as_ref().map(|sha| Anchor {
        kind: "commit".to_string(),
        value: sha.clone(),
    });
    let provenance = format!("trajectory-distiller:{}", item.id);
    let lessons = item.lessons.clone().unwrap_or_default();
    if !lessons.is_empty() {
        return lessons
            .iter()
            .filter(|l| !l.id.is_empty() && !l.text.is_empty())
            .map(|l| DistilledProposal {
                key: EntityKey::new("", l.kind.as_deref().unwrap_or("rule"), &l.id),
                description: l.text.clone(),
                anchor: anchor.clone(),
                provenance: provenance.clone(),
                theta0: 0.35,
                author: "trajectory-distiller".to_string(),
                note: format!("Distilled from incident {}: {}", item.id, item.title),
            })
            .collect();
    }
    let mut slug = String::new();
    for c in item.id.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            slug.push(c);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    vec![DistilledProposal {
        key: EntityKey::new("", "recipe", format!("incident-{slug}")),
        description: item.title.clone(),
        anchor,
        provenance,
        theta0: 0.35,
        author: "trajectory-distiller".to_string(),
        note: format!("Distilled from incident {}", item.id),
    }]
}

/// The appended proposal and the promotion decision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProposeOutcome {
    pub appended: AppendResult,
    pub promoted: bool,
    pub promotion_reason: String,
    /// Every distinct source that has proposed this entity, this one included.
    pub provenances: Vec<String>,
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

    /// Open any store and build an engine on it, keeping how it opened: a log that opened corrupt
    /// refuses evidence reads (gh-18), as with `open_sqlite`.
    pub fn open_with(mut store: S, config: MedhaConfig) -> Result<Self, MedhaError> {
        let opened = store.open()?;
        Ok(Self {
            store,
            sync: Box::new(NoopSyncAdapter),
            config,
            signals: medha_core::canonical_signals(),
            kinds: builtin_kinds(),
            opened,
        })
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
        for ks in &registries.kind_specs {
            if !kinds.contains(&ks.name) {
                kinds.push(ks.name.clone());
            }
        }
        self.kinds = kinds;
        self.store.set_registries(registries.clone());
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

    /// Refuse a blank id on a key that names no entity yet, as the TypeScript `freshState` does:
    /// such an entity could never be created, so every read or write of it is refused.
    fn require_creatable(&self, key: &EntityKey) -> Result<(), MedhaError> {
        if key.id.trim().is_empty() && self.store.get(key)?.is_none() {
            return Err(MedhaError::InvalidArgument {
                name: "key.id",
                reason: format!("expected a non-empty string, received {}", key.id),
            });
        }
        Ok(())
    }

    /// Refuse an episode whose key has a blank id, as the TypeScript store's `validateEpisodeInput`
    /// does on every append.
    fn require_episode_key(key: &EntityKey) -> Result<(), MedhaError> {
        if key.id.trim().is_empty() {
            return Err(MedhaError::InvalidArgument {
                name: "episode.key.id",
                reason: format!("expected a non-empty string, received {}", key.id),
            });
        }
        Ok(())
    }

    /// Refuse a key whose kind is not registered (TypeScript `requireKind`).
    pub fn require_kind(&self, key: &EntityKey) -> Result<(), MedhaError> {
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
        self.require_creatable(key)?;
        let state = self
            .store
            .get(key)?
            .unwrap_or_else(|| fresh_state(key.clone()));

        let default_thresholds = Thresholds::default();
        let default_recency = RecencyConfig::default();
        let kind_spec = self.store.registries().kind_spec(&key.kind);
        let thresholds = kind_spec
            .map(|ks| &ks.thresholds)
            .unwrap_or(&default_thresholds);
        let recency_config = kind_spec.map(|ks| &ks.recency).unwrap_or(&default_recency);

        let computation = compute_trust_and_status(TrustComputationInput {
            evidence: &state.evidence,
            guard: &state.guard,
            distinct_anchor_count: durability_anchor_count(&state),
            ema: &state.ema,
            last_signal_at: state.last_signal_at,
            now,
            stored_status: state.status,
            status_override: state.status_override,
            thresholds,
            recency_config,
            rejecting_authors: state.rejecting_authors.as_ref().map(Vec::len),
            observed_roles: state.observed_roles.as_deref(),
            convergence_gates: kind_spec.and_then(|ks| ks.convergence_gates.as_ref()),
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

    /// PolicyLatch (medha-534):
    /// Regulated agent compliance & human gatekeeper via decision trees and requireHumanFor.
    pub fn policy_latch(
        &self,
        input: &medha_core::policy_latch::PolicyLatchInput,
        now: i64,
    ) -> Result<medha_core::policy_latch::PolicyLatchOutcome, MedhaError> {
        let state_opt = self.store.get(&input.key)?;
        let latch = self.latch_of(&input.key)?;
        let is_latched = latch.is_some();

        let kind_spec = self
            .store
            .registries()
            .kind_specs
            .iter()
            .find(|k| k.name == input.key.kind);

        let (state_summary, decision_tree) = if let Some(ref s) = state_opt {
            let trust = self.hint(&input.key, now)?.trust;
            let summary =
                medha_core::policy_latch::PolicyLatchEntityState::new(s.status, s.evidence.clone())
                    .with_trust(trust);
            (Some(summary), s.decision_tree.clone())
        } else {
            let key_str = input.key.to_string_repr();
            let all_eps = self.store.episodes(None, None)?;
            let key_eps: Vec<Episode> = all_eps
                .into_iter()
                .filter(|e| e.key.to_string_repr() == key_str)
                .collect();
            if !key_eps.is_empty() {
                let mut temp_state: Option<EntityState> = None;
                for ep in &key_eps {
                    temp_state = medha_store::folding::fold_episode_with_registries(
                        temp_state,
                        ep,
                        Some(self.store.registries()),
                    );
                }
                let dt = temp_state
                    .as_ref()
                    .map(|s| s.decision_tree.clone())
                    .unwrap_or_default();
                let summary = medha_core::policy_latch::PolicyLatchEntityState::new(
                    LifecycleStatus::Probation,
                    medha_core::types::Evidence::default(),
                );
                (Some(summary), dt)
            } else {
                (None, Vec::new())
            }
        };

        let outcome = medha_core::policy_latch::evaluate_policy_latch(
            state_summary.as_ref(),
            &decision_tree,
            kind_spec,
            input,
            now,
            is_latched,
        )?;

        Ok(outcome)
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
            state = fold_episode_with_registries(state, ep, Some(self.store.registries()));
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

        let default_thresholds = Thresholds::default();
        let kind_spec = self.store.registries().kind_spec(&key.kind);
        let thresholds = kind_spec
            .map(|ks| &ks.thresholds)
            .unwrap_or(&default_thresholds);

        let is_guarded = !state.guard.kind.is_empty() && state.guard.kind != "none";
        let guard_passed = state.guard.last_ok == Some(true);
        let trials_u64 = state.evidence.n.round() as u64;

        // 1. Trusted Gate
        let t_cond1 = hint.trust >= thresholds.trusted;
        let t_cond2 = trials_u64 >= thresholds.min_uses_for_trusted;
        let t_cond3 = is_guarded && guard_passed;
        let trusted_met = t_cond1 && t_cond2 && t_cond3;

        let trusted_gate = GateExplanation {
            name: "trusted".to_string(),
            met: trusted_met,
            conditions: vec![
                ConditionStatus {
                    label: format!("trust {:.3} >= {:.2}", hint.trust, thresholds.trusted),
                    met: t_cond1,
                },
                ConditionStatus {
                    label: format!("uses {} >= {}", trials_u64, thresholds.min_uses_for_trusted),
                    met: t_cond2,
                },
                ConditionStatus {
                    label: format!("guard passed ({})", if guard_passed { "yes" } else { "no" }),
                    met: t_cond3,
                },
            ],
        };

        // 2. Active Gate
        let a_cond1 = hint.trust >= thresholds.active;
        let active_gate = GateExplanation {
            name: "active".to_string(),
            met: a_cond1,
            conditions: vec![ConditionStatus {
                label: format!("trust {:.3} >= {:.2}", hint.trust, thresholds.active),
                met: a_cond1,
            }],
        };

        // 3. Retired Gate
        let r_cond1 = trials_u64 >= thresholds.min_uses_for_retired;
        let l_times_g = hint.breakdown.wilson_lower * hint.breakdown.guard_factor;
        let r_cond2 = l_times_g < thresholds.retired_trust_threshold;
        let retired_met = r_cond1 && r_cond2;

        let retired_gate = GateExplanation {
            name: "retired".to_string(),
            met: retired_met,
            conditions: vec![
                ConditionStatus {
                    label: format!("uses {} >= {}", trials_u64, thresholds.min_uses_for_retired),
                    met: r_cond1,
                },
                ConditionStatus {
                    label: format!(
                        "undecayed L*G {:.3} < {:.2}",
                        l_times_g, thresholds.retired_trust_threshold
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
            sig: None,
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

        let next_state = fold_episode_with_registries(
            Some(current_state),
            &sim_episode,
            Some(self.store.registries()),
        )
        .unwrap_or_else(|| fresh_state(key.clone()));

        let default_thresholds = Thresholds::default();
        let default_recency = RecencyConfig::default();
        let kind_spec = self.store.registries().kind_spec(&key.kind);
        let thresholds = kind_spec
            .map(|ks| &ks.thresholds)
            .unwrap_or(&default_thresholds);
        let recency_config = kind_spec.map(|ks| &ks.recency).unwrap_or(&default_recency);

        let computation = compute_trust_and_status(TrustComputationInput {
            evidence: &next_state.evidence,
            guard: &next_state.guard,
            distinct_anchor_count: durability_anchor_count(&next_state),
            ema: &next_state.ema,
            last_signal_at: next_state.last_signal_at,
            now,
            stored_status: next_state.status,
            status_override: next_state.status_override,
            thresholds,
            recency_config,
            rejecting_authors: next_state.rejecting_authors.as_ref().map(Vec::len),
            observed_roles: next_state.observed_roles.as_deref(),
            convergence_gates: kind_spec.and_then(|ks| ks.convergence_gates.as_ref()),
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
        self.record_with_updater(input, None)
    }

    /// `record`, with the weight updater named (else the entity's own, `ema` by default):
    /// `ema`, `wilson`, `sliding-window` or `asymmetric-penalty` (alias `asymmetric`), as the
    /// TypeScript built-ins. An unknown name falls back to `ema`, as the TypeScript registry does.
    pub fn record_with_updater(
        &mut self,
        input: RecordInput,
        updater: Option<&str>,
    ) -> Result<AppendResult, MedhaError> {
        self.require_kind(&input.key)?;
        let spec = self.signals.get(&input.signal).cloned().ok_or_else(|| {
            MedhaError::InvalidArgument {
                name: "signal",
                reason: format!("Unknown signal '{}'", input.signal),
            }
        })?;
        // As the TypeScript engine: a new entity's key is checked before the caseId, the episode's
        // key when it is appended.
        if input.ensure {
            self.require_creatable(&input.key)?;
        }
        if let Some(case_id) = &input.case_id {
            // A typo'd caseId would fold into the entity as usual and leave the named branch
            // untouched. Refuse it and name the branches that exist (as the TypeScript engine does).
            let mut known: Vec<String> = self
                .store
                .get(&input.key)?
                .map(|s| s.decision_tree.iter().map(|c| c.id.clone()).collect())
                .unwrap_or_default();
            if !known.iter().any(|id| id == case_id) {
                known.sort();
                let expected = if known.is_empty() {
                    "a decision case id (this entity has no decision branches yet)".to_string()
                } else {
                    format!(
                        "an existing decision case id of this entity (has: {})",
                        known.join(", ")
                    )
                };
                return Err(MedhaError::InvalidArgument {
                    name: "options.caseId",
                    reason: format!("expected {expected}, received {case_id}"),
                });
            }
        }
        Self::require_episode_key(&input.key)?;

        // Like the TypeScript write plane, the episode carries the weight-updater's result, so the
        // fold applies it as written. Only the `ema` updater exists here; any other name falls
        // back to it, as the TypeScript registry does for an updater it cannot load.
        let base = match self.store.get(&input.key)? {
            Some(state) => Some(state),
            None if input.ensure => Some(fresh_state_at(input.key.clone(), input.at)),
            None => None,
        };
        let computed = match &base {
            Some(state) => Some(compute_weight(
                updater.unwrap_or(state.updater.as_str()),
                state,
                &spec,
            )?),
            None => None,
        };
        let (updater_name, weight) = match computed {
            Some((name, w)) => (Some(name), Some(w)),
            None => (None, None),
        };

        let episode_input = EpisodeInput {
            key: input.key,
            at: input.at,
            author: input.author,
            sig: None,
            payload: EpisodePayload::Signal {
                spec,
                anchors: input.anchors,
                ensure: input.ensure,
                run_ref: input.run_ref,
                note: input.note,
                updater: updater_name,
                weight,
                case_id: input.case_id,
            },
        };

        Ok(self.store.append(episode_input)?)
    }

    pub fn guard(&mut self, input: GuardInput) -> Result<AppendResult, MedhaError> {
        self.require_kind(&input.key)?;
        Self::require_episode_key(&input.key)?;
        // A report without a kind counts against the entity's current guard kind, and the episode
        // says so (TypeScript: `report.kind ?? state.guard.kind`).
        let kind = match input.kind {
            Some(kind) => Some(kind),
            None => self.store.get(&input.key)?.map(|state| state.guard.kind),
        };
        let episode_input = EpisodeInput {
            key: input.key,
            at: input.at,
            author: input.author,
            sig: None,
            payload: EpisodePayload::Guard {
                ok: input.ok,
                kind,
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
            sig: None,
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
        self.retract_checked_by(seq, reason, at, expect, None)
    }

    /// `retract_checked` with the retracting author recorded on the episode.
    pub fn retract_checked_by(
        &mut self,
        seq: u64,
        reason: &str,
        at: i64,
        expect: Option<&EntityKey>,
        author: Option<String>,
    ) -> Result<RetractOutcome, MedhaError> {
        let all_eps = self.store.episodes(None, None)?;
        let target_key = all_eps
            .iter()
            .find(|e| e.seq == seq)
            .map(|e| e.key.clone())
            .ok_or_else(|| MedhaError::NotFound(format!("Episode with sequence {}", seq)))?;
        if let Some(expected) = expect {
            if expected != &target_key {
                // The TypeScript engine's wording; the part after "\nhint: " is the hint.
                let label = |k: &EntityKey| format!("{}/{}/{}", k.namespace, k.kind, k.id);
                return Err(MedhaError::InvalidArgument {
                    name: "targetSeq",
                    reason: format!(
                        "expected an episode of {}, received {seq}\nhint: episode #{seq} belongs to {}; check the seq with 'medha show'",
                        label(expected),
                        label(&target_key)
                    ),
                });
            }
        }
        let before = match self.store.get(&target_key)? {
            Some(_) => Some(self.hint(&target_key, at)?.status),
            None => None,
        };

        let target_id = all_eps
            .iter()
            .find(|e| e.seq == seq)
            .and_then(|e| serde_json::to_value(e).ok())
            .and_then(|v| medha_core::signing::episode_id_for_value(&v).ok());

        let episode_input = EpisodeInput {
            key: target_key.clone(),
            at,
            author,
            sig: None,
            payload: EpisodePayload::Retract {
                target_seq: seq,
                target_id,
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

    pub const REMOVED_EPISODES_META_KEY: &'static str = "audit:removedEpisodes";

    pub fn remove_episode(&mut self, seq: u64) -> Result<(), MedhaError> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        self.remove_episode_with_audit(seq, None, None, now)?;
        Ok(())
    }

    pub fn remove_episode_with_audit(
        &mut self,
        seq: u64,
        author: Option<String>,
        reason: Option<String>,
        now: i64,
    ) -> Result<bool, MedhaError> {
        let episodes = self.store.episodes(None, None)?;
        let mut target_ep = None;
        let mut filtered = Vec::new();
        let mut new_seq = 0;
        for ep in episodes {
            if ep.seq == seq {
                target_ep = Some(ep);
                continue;
            }
            let mut updated = ep;
            updated.seq = new_seq;
            new_seq += 1;
            filtered.push(updated);
        }
        let Some(target) = target_ep else {
            return Err(MedhaError::NotFound(format!(
                "Episode with sequence {}",
                seq
            )));
        };
        self.store.replace_log(&filtered)?;
        self.store.rebuild()?;

        // Audit logging: record removed episode trace in meta (matching TS removedEpisodes)
        let mut audit: Vec<serde_json::Value> = self
            .store
            .get_meta(Self::REMOVED_EPISODES_META_KEY)?
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        audit.push(serde_json::json!({
            "removedAt": now,
            "author": author,
            "reason": reason,
            "episode": target,
        }));
        if let Ok(serialized) = serde_json::to_string(&audit) {
            let _ = self
                .store
                .set_meta(Self::REMOVED_EPISODES_META_KEY, &serialized);
        }
        Ok(true)
    }

    pub fn propose(
        &mut self,
        key: &EntityKey,
        provenance: &str,
        theta0: Option<f64>,
        description: Option<String>,
        at: i64,
    ) -> Result<AppendResult, MedhaError> {
        Ok(self
            .propose_with(ProposeInput {
                key: key.clone(),
                provenance: provenance.to_string(),
                theta0,
                description,
                evidence_refs: None,
                author: None,
                note: None,
                anchor: None,
                at,
            })?
            .appended)
    }

    /// Distil a trajectory into candidate proposals (TypeScript `Medha#distillTrajectory`); with
    /// `auto_file` each candidate is proposed, so it enters on probation. Returns the candidates
    /// and how many were filed.
    pub fn distill_trajectory(
        &mut self,
        trajectory: &TrajectoryEvidence,
        auto_file: bool,
        at: i64,
    ) -> Result<(Vec<DistilledProposal>, usize), MedhaError> {
        let proposals = distill_proposals(trajectory);
        let mut filed = 0;
        if auto_file {
            for p in &proposals {
                self.propose_with(ProposeInput {
                    key: p.key.clone(),
                    provenance: p.provenance.clone(),
                    theta0: Some(p.theta0),
                    description: Some(p.description.clone()),
                    evidence_refs: None,
                    author: None,
                    note: Some(p.note.clone()),
                    anchor: p.anchor.clone(),
                    at,
                })?;
                filed += 1;
            }
        }
        Ok((proposals, filed))
    }

    /// Propose with the default promotion policy (spec §7.3, TypeScript `convergingSourcesPolicy`):
    /// promoted once at least two distinct sources have proposed the entity. Promotion is recorded
    /// on the episode and reported; it never changes the fold.
    pub fn propose_with(&mut self, input: ProposeInput) -> Result<ProposeOutcome, MedhaError> {
        const MIN_SOURCES: usize = 2;
        self.require_kind(&input.key)?;
        if input.provenance.trim().is_empty() {
            return Err(MedhaError::InvalidArgument {
                name: "provenance",
                reason: format!("expected a non-empty string, received {}", input.provenance),
            });
        }
        let repr = input.key.to_string_repr();
        let mut provenances: Vec<String> = Vec::new();
        for e in self.store.episodes(None, None)? {
            if e.key.to_string_repr() != repr {
                continue;
            }
            if let EpisodePayload::Proposal { provenance, .. } = &e.payload {
                if !provenances.contains(provenance) {
                    provenances.push(provenance.clone());
                }
            }
        }
        if !provenances.contains(&input.provenance) {
            provenances.push(input.provenance.clone());
        }
        let promoted = provenances.len() >= MIN_SOURCES;
        let reason = if promoted {
            format!(
                "{} converging sources: {} (threshold >= {MIN_SOURCES})",
                provenances.len(),
                provenances.join(", ")
            )
        } else {
            format!(
                "Requires >= {MIN_SOURCES} converging sources; saw {} ({})",
                provenances.len(),
                if provenances.is_empty() {
                    "none".to_string()
                } else {
                    provenances.join(", ")
                }
            )
        };
        let episode_input = EpisodeInput {
            key: input.key.clone(),
            at: input.at,
            author: input.author,
            sig: None,
            payload: EpisodePayload::Proposal {
                provenance: input.provenance,
                theta0: input.theta0,
                description: input.description,
                evidence_refs: input.evidence_refs,
                anchor: input.anchor,
                promoted: Some(promoted),
                promotion_reason: Some(reason.clone()),
                note: input.note,
            },
        };
        let appended = self.store.append(episode_input)?;
        Ok(ProposeOutcome {
            appended,
            promoted,
            promotion_reason: reason,
            provenances,
        })
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
            sig: None,
            payload: EpisodePayload::Define {
                definition: EntityDefinition {
                    title: title.to_string(),
                    rationale: rationale.to_string(),
                    tags,
                    context_targets: None,
                },
            },
        };

        Ok(self.store.append(episode_input)?)
    }

    pub fn define_entity(
        &mut self,
        key: &EntityKey,
        definition: EntityDefinition,
        at: i64,
    ) -> Result<AppendResult, MedhaError> {
        self.require_kind(key)?;
        Self::require_episode_key(key)?;
        let episode_input = EpisodeInput {
            key: key.clone(),
            at,
            author: None,
            sig: None,
            payload: EpisodePayload::Define { definition },
        };

        Ok(self.store.append(episode_input)?)
    }

    /// Grow or edit a branch of an entity's decision tree, validated as the TypeScript engine does
    /// (`validateDecisionTreeEdit`, medha-arj.4): a given `case_id` must name an existing branch
    /// (it is an edit); a parent must exist and must not be the branch or one of its descendants;
    /// no sibling may already use the same (normalized) condition; and a decision type the kind's
    /// `decisionPolicy.requireHumanFor` gates needs a `human:` author. Returns the case id.
    pub fn decision_with(
        &mut self,
        input: DecisionInput,
    ) -> Result<(AppendResult, String), MedhaError> {
        self.require_kind(&input.key)?;
        let tree = self
            .store
            .get(&input.key)?
            .map(|s| s.decision_tree)
            .unwrap_or_default();
        let invalid =
            |name: &'static str, expected: String, received: &str| MedhaError::InvalidArgument {
                name,
                reason: format!("expected {expected}, received {received}"),
            };
        let mut known: Vec<String> = tree.iter().map(|c| c.id.clone()).collect();
        known.sort();
        let existing = |known: &[String]| {
            if known.is_empty() {
                None
            } else {
                Some(format!(
                    "an existing decision case id of this entity (has: {})",
                    known.join(", ")
                ))
            }
        };
        let case_id = match &input.case_id {
            Some(id) => {
                if !known.contains(id) {
                    return Err(invalid(
                        "decision.caseId",
                        existing(&known).unwrap_or_else(|| {
                            "not supplied: this entity has no decision branches to edit".to_string()
                        }),
                        id,
                    ));
                }
                id.clone()
            }
            None => new_decision_case_id(&input.key, input.at),
        };
        if input.detach && input.parent_id.is_some() {
            return Err(invalid(
                "decision.detach",
                "not combined with a parentId (detach means 'move to the top level')".to_string(),
                input.parent_id.as_deref().unwrap_or(""),
            ));
        }
        let parent = if input.detach {
            None
        } else {
            input.parent_id.clone().or_else(|| {
                tree.iter()
                    .find(|c| c.id == case_id)
                    .and_then(|c| c.parent_id.clone())
            })
        };
        if let Some(p) = &parent {
            if p == &case_id {
                return Err(invalid(
                    "decision.parentId",
                    "a branch other than itself".to_string(),
                    p,
                ));
            }
            if !known.contains(p) {
                return Err(invalid(
                    "decision.parentId",
                    existing(&known).unwrap_or_else(|| {
                        "a decision case id (this entity has no decision branches yet)".to_string()
                    }),
                    p,
                ));
            }
            let mut cursor = Some(p.clone());
            while let Some(c) = cursor {
                if c == case_id {
                    return Err(invalid(
                        "decision.parentId",
                        "a branch that is not a descendant of this branch".to_string(),
                        p,
                    ));
                }
                cursor = tree
                    .iter()
                    .find(|k| k.id == c)
                    .and_then(|k| k.parent_id.clone());
            }
        }
        let normalized = normalize_condition(&input.condition);
        if let Some(dup) = tree.iter().find(|k| {
            k.id != case_id
                && k.parent_id == parent
                && normalize_condition(&k.condition) == normalized
        }) {
            return Err(invalid(
                "decision.condition",
                format!(
                    "a condition no sibling of this branch already uses (sibling {} uses it)",
                    dup.id
                ),
                &input.condition,
            ));
        }
        let decision_type = match &input.decision {
            Decision::Apply => "apply",
            Decision::Ignore => "ignore",
            Decision::Probability { .. } => "probability",
        };
        let gated = self
            .store
            .registries()
            .kind_spec(&input.key.kind)
            .and_then(|ks| ks.decision_policy.as_ref())
            .and_then(|p| p.require_human_for.as_ref())
            .is_some_and(|types| types.iter().any(|t| t == decision_type));
        if gated && !medha_core::decision::is_human_author(input.author.as_deref()) {
            // The part after the hint separator is the hint (see the CLI's failure mapping).
            return Err(MedhaError::PermissionDenied(format!(
                "Permission denied for 'decision:{decision_type}': kind '{}' requires a human to grant a '{decision_type}' branch\nhint: Do not retry with another author: 'human:' is a label the caller sets itself, and passing it is not verification. Escalate to a human, who must run this command themselves.",
                input.key.kind
            )));
        }
        let appended = self.store.append(EpisodeInput {
            key: input.key.clone(),
            at: input.at,
            author: input.author,
            sig: None,
            payload: EpisodePayload::Decision {
                case_id: case_id.clone(),
                parent_id: input.parent_id,
                detach: input.detach.then_some(true),
                condition: input.condition,
                decision: input.decision,
            },
        })?;
        Ok((appended, case_id))
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
            sig: None,
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
                    sig: None,
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

    /// Fold the *entire* log into one baseline per entity (the `keys adopt` path). For routine
    /// maintenance use [`Self::compact_older_than`], which keeps recent history retractable.
    pub fn compact(&mut self, _now: i64) -> Result<CompactionReport, MedhaError> {
        self.compact_before(i64::MAX)
    }

    /// Fold only episodes older than `older_than_days` (default [`DEFAULT_FOLD_DAYS`]) into
    /// baselines, keeping the newer suffix verbatim — mirrors the TypeScript `compactPrefix`.
    pub fn compact_older_than(
        &mut self,
        now: i64,
        older_than_days: Option<f64>,
    ) -> Result<CompactionReport, MedhaError> {
        let days = older_than_days.unwrap_or(DEFAULT_FOLD_DAYS);
        let cutoff_at = now.saturating_sub((days * DAY_MS) as i64);
        self.compact_before(cutoff_at)
    }

    fn compact_before(&mut self, cutoff_at: i64) -> Result<CompactionReport, MedhaError> {
        let mut eps = self.store.episodes(None, None)?;
        eps.sort_by_key(|e| e.seq);
        let before_count = eps.len();
        let states = self.store.list()?;

        // The folded prefix is the longest run of episodes strictly older than the cutoff.
        let border = eps.iter().take_while(|e| e.at < cutoff_at).count();
        if border == 0 {
            return Ok(CompactionReport {
                before_count,
                after_count: before_count,
                removed_count: 0,
            });
        }
        let (prefix, suffix) = eps.split_at(border);
        let max_prefix_seq = prefix.last().map(|e| e.seq).unwrap_or(0);

        // A retraction in the suffix may target the prefix: its effect belongs in the baseline,
        // so mask that target while folding and drop the spent retraction. A retraction that
        // targets a kept episode is renumbered below; one that targets nothing is dropped.
        let suffix_seqs: std::collections::HashSet<u64> = suffix.iter().map(|e| e.seq).collect();
        let mut spent_on_prefix: std::collections::HashSet<u64> = std::collections::HashSet::new();
        let kept_suffix: Vec<&Episode> = suffix
            .iter()
            .filter(|e| match &e.payload {
                EpisodePayload::Retract { target_seq, .. } => {
                    if *target_seq > max_prefix_seq {
                        suffix_seqs.contains(target_seq)
                    } else {
                        spent_on_prefix.insert(*target_seq);
                        false
                    }
                }
                _ => true,
            })
            .collect();

        let prefix_live: Vec<Episode> = prefix
            .iter()
            .filter(|e| !spent_on_prefix.contains(&e.seq))
            .cloned()
            .collect();
        let folded = medha_store::folding::fold_log_with_registries(
            &prefix_live,
            Some(self.store.registries()),
        );
        let mut last_at: HashMap<String, i64> = HashMap::new();
        for e in prefix {
            let k = e.key.to_string_repr();
            let entry = last_at.entry(k).or_insert(e.at);
            if e.at > *entry {
                *entry = e.at;
            }
        }
        let mut baseline_states: Vec<EntityState> = folded.into_values().collect();
        baseline_states.sort_by_key(|s| s.key.to_string_repr());

        let mut new_eps = Vec::with_capacity(baseline_states.len() + kept_suffix.len());
        for (seq, s) in baseline_states.into_iter().enumerate() {
            let at = last_at
                .get(&s.key.to_string_repr())
                .copied()
                .unwrap_or(cutoff_at);
            new_eps.push(Episode {
                seq: seq as u64,
                key: s.key.clone(),
                at,
                author: None,
                sig: None,
                payload: EpisodePayload::Baseline { state: s },
            });
        }
        let offset = new_eps.len() as u64;
        let new_seq_of: HashMap<u64, u64> = kept_suffix
            .iter()
            .enumerate()
            .map(|(i, e)| (e.seq, offset + i as u64))
            .collect();
        for (i, e) in kept_suffix.iter().enumerate() {
            let mut ep = (*e).clone();
            ep.seq = offset + i as u64;
            if let EpisodePayload::Retract { target_seq, .. } = &mut ep.payload {
                *target_seq = new_seq_of[target_seq];
            }
            new_eps.push(ep);
        }

        // Bake-and-verify: verify fold-equivalence in memory before replacing the log
        let verified_states =
            medha_store::folding::fold_log_with_registries(&new_eps, Some(self.store.registries()));
        for s in &states {
            let key_str = s.key.to_string_repr();
            if let Some(folded) = verified_states.get(&key_str) {
                if (folded.evidence.k - s.evidence.k).abs() > 1e-6
                    || (folded.evidence.n - s.evidence.n).abs() > 1e-6
                {
                    return Err(MedhaError::Store(medha_store::StoreError::CorruptStore {
                        store_path: "compact".into(),
                        at_seq: 0,
                        reason: "bake-and-verify failed: fold-equivalence violation on compaction"
                            .into(),
                    }));
                }
            }
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
        self.pack_in_context(options, None, now)
    }

    /// `pack`, keeping only entities whose definition's context targets match the active context
    /// (TypeScript `Medha#hintsForContext` / `matchesContextTargets`, medha-c8z.1). An entity
    /// with no definition or no targets always matches.
    pub fn pack_in_context(
        &self,
        options: EnginePackOptions,
        filter: Option<&ContextFilter>,
        now: i64,
    ) -> Result<PackOutcome, MedhaError> {
        self.require_readable()?;
        let definitions: HashMap<String, Option<medha_store::ContextTargets>> = match filter {
            None => HashMap::new(),
            Some(_) => {
                let mut defs = HashMap::new();
                for e in self.store.episodes(None, None)? {
                    if let EpisodePayload::Define { definition } = &e.payload {
                        defs.insert(e.key.to_string_repr(), definition.context_targets.clone());
                    }
                }
                defs
            }
        };
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
            if let Some(f) = filter {
                let targets = definitions
                    .get(&state.key.to_string_repr())
                    .cloned()
                    .flatten();
                if !matches_context_targets(targets.as_ref(), f) {
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

    /// The negative-evidence radar (TypeScript `Medha#detectPitfalls`, medha-c8z.4): retired or
    /// quarantined entities with at least `min_failures` trials, or a failing guard.
    pub fn detect_pitfalls(
        &self,
        kind: Option<&str>,
        namespace: Option<&str>,
        min_failures: f64,
        limit: Option<usize>,
        now: i64,
    ) -> Result<Vec<Pitfall>, MedhaError> {
        self.require_readable()?;
        let mut out = Vec::new();
        for state in self.store.list()? {
            if kind.is_some_and(|k| state.key.kind != k)
                || namespace.is_some_and(|n| state.key.namespace != n)
            {
                continue;
            }
            let hint = self.hint(&state.key, now)?;
            let status = match hint.status {
                LifecycleStatus::Retired => "retired",
                LifecycleStatus::Quarantined => "quarantined",
                _ => continue,
            };
            let trials = state.evidence.n;
            let guard_failing = hint.breakdown.guard_factor == 0.0;
            if trials < min_failures && !guard_failing {
                continue;
            }
            let reason = if status == "retired" {
                format!(
                    "Retired after {} trials with low trust ({} successes)",
                    js_number(trials),
                    js_number(state.evidence.k)
                )
            } else {
                format!(
                    "Quarantined ({})",
                    if guard_failing {
                        "guard failed"
                    } else {
                        "downward weight drift"
                    }
                )
            };
            out.push(Pitfall {
                key: state.key.clone(),
                status: status.to_string(),
                trials,
                successes: state.evidence.k,
                failing_guard: guard_failing.then(|| "guard".to_string()),
                last_note: state.last_note.clone(),
                reason,
            });
        }
        if let Some(l) = limit {
            out.truncate(l);
        }
        Ok(out)
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
