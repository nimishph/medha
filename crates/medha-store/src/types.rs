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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum EpisodePayload {
    Signal {
        spec: SignalSpec,
        #[serde(default)]
        anchors: Option<Vec<Anchor>>,
        #[serde(default)]
        ensure: bool,
        #[serde(default)]
        run_ref: Option<String>,
        #[serde(default)]
        note: Option<String>,
        #[serde(default)]
        updater: Option<String>,
        #[serde(default)]
        weight: Option<f64>,
        #[serde(default)]
        case_id: Option<String>,
    },
    Guard {
        ok: bool,
        #[serde(default)]
        kind: Option<String>,
        #[serde(default)]
        ensure: bool,
        #[serde(default)]
        note: Option<String>,
    },
    Override {
        override_type: String,
        reason: String,
    },
    Proposal {
        provenance: String,
        #[serde(default)]
        theta0: Option<f64>,
        #[serde(default)]
        description: Option<String>,
        #[serde(default)]
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
        target_seq: u64,
        reason: String,
    },
    Define {
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        description: Option<String>,
        #[serde(default)]
        tags: Option<Vec<String>>,
        #[serde(default)]
        rationale: Option<String>,
    },
    Decision {
        case_id: String,
        #[serde(default)]
        parent_id: Option<String>,
        condition: String,
        decision: medha_core::decision::Decision,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EpisodeInput {
    pub key: EntityKey,
    pub at: i64,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(flatten)]
    pub payload: EpisodePayload,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Episode {
    pub seq: u64,
    pub key: EntityKey,
    pub at: i64,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(flatten)]
    pub payload: EpisodePayload,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EntityState {
    pub key: EntityKey,
    pub evidence: Evidence,
    pub guard: GuardState,
    #[serde(default)]
    pub anchors: Vec<Anchor>,
    pub ema: EmaState,
    pub status: LifecycleStatus,
    #[serde(default)]
    pub status_override: Option<LifecycleStatus>,
    #[serde(default)]
    pub last_signal_at: Option<i64>,
    #[serde(default = "default_updater")]
    pub updater: String,
    #[serde(default)]
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
