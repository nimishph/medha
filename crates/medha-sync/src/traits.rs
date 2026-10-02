use crate::errors::SyncError;
use crate::snapshot::MemorySnapshotV1;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncState {
    Synced,
    Ahead,
    Behind,
    Diverged,
    Uninitialized,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncStatus {
    pub state: SyncState,
    pub local_count: usize,
    #[serde(default)]
    pub remote_count: Option<usize>,
    #[serde(default)]
    pub local_head: Option<String>,
    #[serde(default)]
    pub remote_head: Option<String>,
    #[serde(default)]
    pub ref_name: Option<String>,
    #[serde(default)]
    pub remote_url: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullResult {
    pub ok: bool,
    pub updated: bool,
    pub pulled_count: usize,
    pub local_total: usize,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PushResult {
    pub ok: bool,
    pub pushed_count: usize,
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReconcileResult {
    pub ok: bool,
    pub pulled_count: usize,
    pub pushed_count: usize,
    pub total_count: usize,
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

use medha_store::StorePort;

pub trait SyncPort: Send + Sync {
    fn name(&self) -> &str;
    fn status(&self, store: &dyn StorePort) -> Result<SyncStatus, SyncError>;
    fn pull(&mut self, store: &mut dyn StorePort) -> Result<PullResult, SyncError>;
    fn push(&mut self, store: &dyn StorePort, now: Option<i64>) -> Result<PushResult, SyncError>;
    fn reconcile(
        &mut self,
        store: &mut dyn StorePort,
        now: Option<i64>,
    ) -> Result<ReconcileResult, SyncError>;
    fn peek(&self) -> Result<Option<MemorySnapshotV1>, SyncError>;
}
