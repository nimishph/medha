use medha_core::decision::DecisionCase;
pub use medha_core::types::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CorruptLocation {
    pub source: String,
    pub at_seq: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum OpenResult {
    Ok,
    Corrupt { location: CorruptLocation },
}

/// An episode as stored in `store.sqlite`. The JSON is the TypeScript engine's: both engines open
/// the same store, so every field it writes is modelled here (a field dropped on read would be lost
/// the next time this engine rewrites the log). The snake_case aliases read stores written by
/// earlier Rust builds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum EpisodePayload {
    Signal {
        spec: SignalSpec,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        anchors: Option<Vec<Anchor>>,
        #[serde(default)]
        ensure: bool,
        #[serde(default, alias = "run_ref", skip_serializing_if = "Option::is_none")]
        run_ref: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        updater: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        weight: Option<f64>,
        #[serde(default, alias = "case_id", skip_serializing_if = "Option::is_none")]
        case_id: Option<String>,
    },
    Guard {
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        kind: Option<String>,
        #[serde(default)]
        ensure: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    Override {
        /// `retired`, `quarantined` or `restore`.
        #[serde(rename = "override", alias = "override_type")]
        override_type: String,
        reason: String,
    },
    Proposal {
        provenance: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        theta0: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        evidence_refs: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        anchor: Option<Anchor>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        promoted: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        promotion_reason: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    Sweep {
        action: String,
        reason: String,
    },
    Baseline {
        state: EntityState,
    },
    Retract {
        #[serde(alias = "target_seq")]
        target_seq: u64,
        reason: String,
    },
    Define {
        definition: EntityDefinition,
    },
    Decision {
        #[serde(alias = "case_id")]
        case_id: String,
        #[serde(default, alias = "parent_id", skip_serializing_if = "Option::is_none")]
        parent_id: Option<String>,
        /// Move an existing branch to the top level (an edit without `parentId` keeps it in place).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detach: Option<bool>,
        condition: String,
        decision: medha_core::decision::Decision,
    },
}

/// A host-authored definition (title, rationale, tags). Never evidential.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EntityDefinition {
    pub title: String,
    pub rationale: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EpisodeInput {
    pub key: EntityKey,
    pub at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(flatten)]
    pub payload: EpisodePayload,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Episode {
    pub seq: u64,
    pub key: EntityKey,
    pub at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(flatten)]
    pub payload: EpisodePayload,
}

/// The folded state of one entity, in the TypeScript engine's shape (it is stored inside baseline
/// episodes, which either engine may read).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityState {
    pub key: EntityKey,
    pub evidence: Evidence,
    pub guard: GuardState,
    #[serde(default)]
    pub anchors: Vec<Anchor>,
    pub ema: EmaState,
    pub status: LifecycleStatus,
    /// The last lifecycle override (`retired` or `quarantined`); cleared by a restore.
    #[serde(default, rename = "override", alias = "status_override")]
    pub status_override: Option<LifecycleStatus>,
    /// When it was (last) retired; survives compaction so retention rules stay a fold of the log.
    #[serde(default)]
    pub retired_at: Option<i64>,
    /// When a human last restored it.
    #[serde(default)]
    pub restored_at: Option<i64>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default, alias = "last_signal_at")]
    pub last_signal_at: Option<i64>,
    #[serde(default = "default_updater")]
    pub updater: String,
    /// The note or rationale from the latest episode that carried one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_note: Option<String>,
    /// Per-author `signalLimits` ledger, kept as written: this engine does not enforce limits yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authors: Option<serde_json::Value>,
    /// Distinct authors of the failed trials, when the kind requires more than one before
    /// retirement (spec §6 step 5.1). Kept as written: this engine does not apply kind specs yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rejecting_authors: Option<Vec<String>>,
    #[serde(
        default,
        alias = "decision_tree",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub decision_tree: Vec<DecisionCase>,
}

fn default_updater() -> String {
    "ema".to_string()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreRegistries {
    #[serde(default)]
    pub kinds: Vec<String>,
    #[serde(default, alias = "signal_specs")]
    pub signal_specs: Vec<SignalSpec>,
    #[serde(default, alias = "anchor_kinds")]
    pub anchor_kinds: Vec<String>,
}

impl Default for StoreRegistries {
    fn default() -> Self {
        Self {
            kinds: vec!["rule".to_string(), "recipe".to_string(), "tool".to_string()],
            signal_specs: medha_core::canonical_signals().into_values().collect(),
            anchor_kinds: vec!["git".to_string(), "week".to_string()],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AppendResult {
    pub episode: Episode,
    pub state: Option<EntityState>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplaceLogResult {
    pub from: u64,
    pub to: u64,
}
