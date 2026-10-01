use crate::errors::SyncError;
use crate::snapshot::MemorySnapshotV1;
use crate::traits::{PullResult, PushResult, ReconcileResult, SyncPort, SyncState, SyncStatus};

pub struct NoopSyncAdapter;

impl SyncPort for NoopSyncAdapter {
    fn name(&self) -> &str {
        "noop"
    }

    fn status(&self) -> Result<SyncStatus, SyncError> {
        Ok(SyncStatus {
            state: SyncState::Synced,
            local_count: 0,
            remote_count: Some(0),
            local_head: None,
            remote_head: None,
            ref_name: None,
            remote_url: None,
            message: Some("No-op sync adapter".to_string()),
        })
    }

    fn peek(&self) -> Result<Option<MemorySnapshotV1>, SyncError> {
        Ok(None)
    }

    fn pull(&mut self) -> Result<PullResult, SyncError> {
        Ok(PullResult {
            ok: true,
            updated: false,
            pulled_count: 0,
            local_total: 0,
            error: None,
        })
    }

    fn push(&mut self, _now: Option<i64>) -> Result<PushResult, SyncError> {
        Ok(PushResult {
            ok: true,
            pushed_count: 0,
            commit: None,
            error: None,
        })
    }

    fn reconcile(&mut self, _now: Option<i64>) -> Result<ReconcileResult, SyncError> {
        Ok(ReconcileResult {
            ok: true,
            pulled_count: 0,
            pushed_count: 0,
            total_count: 0,
            commit: None,
            error: None,
        })
    }
}
