use medha_core::types::LifecycleStatus;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct SweepOptions {
    pub prune_retired: bool,
    pub max_age_days: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SweepChange {
    pub key: String,
    pub previous_status: LifecycleStatus,
    pub new_status: LifecycleStatus,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct SweepReport {
    pub swept_count: usize,
    pub changes: Vec<SweepChange>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct CompactionReport {
    pub before_count: usize,
    pub after_count: usize,
    pub removed_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PreflightReport {
    pub ok: bool,
    pub total_entities: usize,
    pub total_episodes: usize,
    pub corrupt_seq: Option<u64>,
    pub issues: Vec<String>,
}
