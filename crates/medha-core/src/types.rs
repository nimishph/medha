use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Error, Debug, PartialEq)]
pub enum CoreError {
    #[error("Non-finite number encountered: {0}")]
    NonFiniteNumber(f64),

    #[error("Invalid argument for '{name}': {reason}")]
    InvalidArgument { name: &'static str, reason: String },

    #[error("Invalid evidence counts: successes={successes}, trials={trials}")]
    InvalidCounts { successes: f64, trials: f64 },

    #[error("Unknown entity: {0}")]
    UnknownEntity(String),

    #[error("Entity key mismatch")]
    KeyMismatch,

    #[error("Unknown signal '{0}'")]
    UnknownSignal(String),

    #[error("Unknown kind '{0}'")]
    UnknownKind(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct EntityKey {
    #[serde(default)]
    pub namespace: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    pub id: String,
}

fn default_kind() -> String {
    "rule".to_string()
}

impl EntityKey {
    pub fn new(
        namespace: impl Into<String>,
        kind: impl Into<String>,
        id: impl Into<String>,
    ) -> Self {
        Self {
            namespace: namespace.into(),
            kind: kind.into(),
            id: id.into(),
        }
    }

    pub fn to_string_repr(&self) -> String {
        if self.namespace.is_empty() {
            format!("{}/{}", self.kind, self.id)
        } else {
            format!("{}/{}/{}", self.namespace, self.kind, self.id)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Anchor {
    pub kind: String,
    pub value: String,
}

impl Anchor {
    pub fn new(kind: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            value: value.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LifecycleStatus {
    Probation,
    Active,
    Trusted,
    Quarantined,
    Retired,
}

// Stored types serialize in the TypeScript engine's camelCase, because both engines read and write
// the same `store.sqlite`. The snake_case aliases keep stores written by earlier Rust builds readable.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardState {
    pub kind: String,
    #[serde(default, alias = "last_ok")]
    pub last_ok: Option<bool>,
    #[serde(default, alias = "last_ok_at")]
    pub last_ok_at: Option<i64>,
}

impl Default for GuardState {
    fn default() -> Self {
        Self {
            kind: "none".to_string(),
            last_ok: None,
            last_ok_at: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmaState {
    pub mu: f64,
    pub theta0: f64,
    /// When the EMA last moved (epoch ms); the TypeScript state always carries it.
    #[serde(default, alias = "updated_at")]
    pub updated_at: i64,
    /// Not part of the stored state: the TypeScript engine has no such field, and trust reads `n`.
    #[serde(default, alias = "sample_count", skip_serializing)]
    pub sample_count: u64,
}

impl Default for EmaState {
    fn default() -> Self {
        Self {
            mu: crate::thresholds::DEFAULT_THETA0,
            theta0: crate::thresholds::DEFAULT_THETA0,
            updated_at: 0,
            sample_count: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub k: f64,
    pub n: f64,
    #[serde(default, alias = "context_rejects")]
    pub context_rejects: u64,
}

fn default_trusted() -> f64 {
    crate::thresholds::TRUSTED_THRESHOLD
}
fn default_min_uses_for_trusted() -> u64 {
    crate::thresholds::MIN_USES_FOR_TRUSTED
}
fn default_active() -> f64 {
    crate::thresholds::ACTIVE_THRESHOLD
}
fn default_unguarded_ceiling() -> f64 {
    crate::thresholds::UNGUARDED_TRUST_CEILING
}
fn default_min_uses_for_retired() -> u64 {
    crate::thresholds::MIN_USES_FOR_RETIRED
}
fn default_retired_trust_threshold() -> f64 {
    crate::thresholds::RETIRED_TRUST_THRESHOLD
}
fn default_min_distinct_authors_for_retired() -> u64 {
    crate::thresholds::MIN_DISTINCT_AUTHORS_FOR_RETIRED
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thresholds {
    #[serde(default = "default_trusted")]
    pub trusted: f64,
    #[serde(default = "default_min_uses_for_trusted", alias = "min_uses_for_trusted")]
    pub min_uses_for_trusted: u64,
    #[serde(default = "default_active")]
    pub active: f64,
    #[serde(default = "default_unguarded_ceiling", alias = "unguarded_ceiling")]
    pub unguarded_ceiling: f64,
    #[serde(default = "default_min_uses_for_retired", alias = "min_uses_for_retired")]
    pub min_uses_for_retired: u64,
    #[serde(default = "default_retired_trust_threshold", alias = "retired_trust_threshold")]
    pub retired_trust_threshold: f64,
    /// Distinct authors needed among the failed trials before retirement (spec §6 step 5.1).
    #[serde(
        default = "default_min_distinct_authors_for_retired",
        alias = "min_distinct_authors_for_retired"
    )]
    pub min_distinct_authors_for_retired: u64,
}

impl Default for Thresholds {
    fn default() -> Self {
        Self {
            trusted: crate::thresholds::TRUSTED_THRESHOLD,
            min_uses_for_trusted: crate::thresholds::MIN_USES_FOR_TRUSTED,
            active: crate::thresholds::ACTIVE_THRESHOLD,
            unguarded_ceiling: crate::thresholds::UNGUARDED_TRUST_CEILING,
            min_uses_for_retired: crate::thresholds::MIN_USES_FOR_RETIRED,
            retired_trust_threshold: crate::thresholds::RETIRED_TRUST_THRESHOLD,
            min_distinct_authors_for_retired: crate::thresholds::MIN_DISTINCT_AUTHORS_FOR_RETIRED,
        }
    }
}

fn default_half_life_days() -> f64 {
    crate::thresholds::RECENCY_HALF_LIFE_DAYS
}
fn default_recency_floor() -> f64 {
    crate::thresholds::RECENCY_FLOOR
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecencyConfig {
    #[serde(default = "default_half_life_days", alias = "half_life_days")]
    pub half_life_days: f64,
    #[serde(default = "default_recency_floor")]
    pub floor: f64,
}

impl Default for RecencyConfig {
    fn default() -> Self {
        Self {
            half_life_days: crate::thresholds::RECENCY_HALF_LIFE_DAYS,
            floor: crate::thresholds::RECENCY_FLOOR,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalSpec {
    pub name: String,
    pub value: f64,
    #[serde(alias = "counts_as_trial")]
    pub counts_as_trial: bool,
    #[serde(alias = "counts_as_success")]
    pub counts_as_success: bool,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrustScoreBreakdown {
    pub score: f64,
    pub wilson_lower: f64,
    pub wilson_upper: f64,
    pub recency: f64,
    pub durability: f64,
    pub guard_factor: f64,
    pub effective_ceiling: f64,
    pub is_drifting: bool,
    pub drift_direction: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrustHint {
    pub key: EntityKey,
    pub trust: f64,
    pub status: LifecycleStatus,
    pub trials: f64,
    pub successes: f64,
    pub is_drifting: bool,
    pub breakdown: TrustScoreBreakdown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct KindConvergenceGates {
    #[serde(default, alias = "min_distinct_roles_for_active")]
    pub min_distinct_roles_for_active: Option<usize>,
    #[serde(default, alias = "min_distinct_roles_for_trusted")]
    pub min_distinct_roles_for_trusted: Option<usize>,
    #[serde(default, alias = "required_roles_for_trusted")]
    pub required_roles_for_trusted: Option<Vec<String>>,
}
