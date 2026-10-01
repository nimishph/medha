use crate::errors::SyncError;
use crate::merge::merge_episodes;
use crate::snapshot::{
    migrate_snapshot, serialize_snapshot, MemorySnapshotV1, CURRENT_MEMORY_SCHEMA_VERSION,
};
use crate::traits::{PullResult, PushResult, ReconcileResult, SyncPort, SyncState, SyncStatus};
use medha_store::StorePort;
use std::fs;
use std::path::{Path, PathBuf};

pub struct FileSyncAdapter<S: StorePort> {
    store: S,
    file_path: PathBuf,
    last_observed_content: Option<Option<String>>,
}

impl<S: StorePort> FileSyncAdapter<S> {
    pub fn new(store: S, file_path: impl AsRef<Path>) -> Self {
        Self {
            store,
            file_path: file_path.as_ref().to_path_buf(),
            last_observed_content: None,
        }
    }

    pub fn store(&self) -> &S {
        &self.store
    }

    pub fn store_mut(&mut self) -> &mut S {
        &mut self.store
    }

    pub fn into_store(self) -> S {
        self.store
    }

    fn read_raw_file(&self) -> Option<String> {
        if self.file_path.exists() {
            fs::read_to_string(&self.file_path).ok()
        } else {
            None
        }
    }

    fn atomic_write_file(&self, content: &str) -> Result<(), SyncError> {
        if let Some(parent) = self.file_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let tmp_path = self.file_path.with_extension(format!("tmp.{}", now));
        fs::write(&tmp_path, content)?;
        fs::rename(&tmp_path, &self.file_path)?;
        Ok(())
    }
}

impl<S: StorePort> SyncPort for FileSyncAdapter<S> {
    fn name(&self) -> &str {
        "file"
    }

    fn status(&self) -> Result<SyncStatus, SyncError> {
        let local_states = self.store.list()?;
        let local_count = local_states.len();
        let ref_str = self.file_path.to_string_lossy().to_string();

        if !self.file_path.exists() {
            return Ok(SyncStatus {
                state: SyncState::Uninitialized,
                local_count,
                remote_count: None,
                local_head: None,
                remote_head: None,
                ref_name: Some(ref_str),
                remote_url: None,
                message: Some(format!(
                    "Sync file does not exist: {}",
                    self.file_path.display()
                )),
            });
        }

        let raw = match fs::read_to_string(&self.file_path) {
            Ok(s) => s,
            Err(e) => {
                return Ok(SyncStatus {
                    state: SyncState::Diverged,
                    local_count,
                    remote_count: None,
                    local_head: None,
                    remote_head: None,
                    ref_name: Some(ref_str),
                    remote_url: None,
                    message: Some(e.to_string()),
                });
            }
        };

        let val: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => {
                return Ok(SyncStatus {
                    state: SyncState::Diverged,
                    local_count,
                    remote_count: None,
                    local_head: None,
                    remote_head: None,
                    ref_name: Some(ref_str),
                    remote_url: None,
                    message: Some(e.to_string()),
                });
            }
        };

        let snapshot = match migrate_snapshot(val) {
            Ok(s) => s,
            Err(e) => {
                return Ok(SyncStatus {
                    state: SyncState::Diverged,
                    local_count,
                    remote_count: None,
                    local_head: None,
                    remote_head: None,
                    ref_name: Some(ref_str),
                    remote_url: None,
                    message: Some(e.to_string()),
                });
            }
        };

        let remote_count = snapshot.entities.len();
        let state = if local_count == remote_count {
            SyncState::Synced
        } else if local_count > remote_count {
            SyncState::Ahead
        } else {
            SyncState::Behind
        };

        Ok(SyncStatus {
            state,
            local_count,
            remote_count: Some(remote_count),
            local_head: None,
            remote_head: None,
            ref_name: Some(ref_str),
            remote_url: None,
            message: None,
        })
    }

    fn peek(&self) -> Result<Option<MemorySnapshotV1>, SyncError> {
        if !self.file_path.exists() {
            return Ok(None);
        }
        let raw = fs::read_to_string(&self.file_path)?;
        let val: serde_json::Value = serde_json::from_str(&raw)?;
        let snapshot = migrate_snapshot(val)?;
        Ok(Some(snapshot))
    }

    fn pull(&mut self) -> Result<PullResult, SyncError> {
        let local_states = self.store.list()?;
        let local_total = local_states.len();

        let raw = self.read_raw_file();
        let raw_str = match raw {
            Some(s) => s,
            None => {
                self.last_observed_content = Some(None);
                return Ok(PullResult {
                    ok: true,
                    updated: false,
                    pulled_count: 0,
                    local_total,
                    error: None,
                });
            }
        };

        let val: serde_json::Value = serde_json::from_str(&raw_str)?;
        let snapshot = migrate_snapshot(val)?;
        self.last_observed_content = Some(Some(raw_str));

        let local_episodes = self.store.episodes(None, None)?;

        if let Some(incoming_eps) = snapshot.episodes {
            if !incoming_eps.is_empty() {
                let merged = merge_episodes(&local_episodes, &incoming_eps);
                if merged.len() != local_episodes.len() {
                    self.store.replace_log(&merged)?;
                    self.store.rebuild()?;
                    let updated_states = self.store.list()?;
                    return Ok(PullResult {
                        ok: true,
                        updated: true,
                        pulled_count: incoming_eps.len(),
                        local_total: updated_states.len(),
                        error: None,
                    });
                }
            }
        }

        Ok(PullResult {
            ok: true,
            updated: false,
            pulled_count: 0,
            local_total,
            error: None,
        })
    }

    fn push(&mut self, now: Option<i64>) -> Result<PushResult, SyncError> {
        // CAS check
        if let Some(ref expected) = self.last_observed_content {
            let current = self.read_raw_file();
            if &current != expected {
                return Ok(PushResult {
                    ok: false,
                    pushed_count: 0,
                    commit: None,
                    error: Some(format!(
                        "Sync file diverged: {} changed since last pull. Pull again before pushing.",
                        self.file_path.display()
                    )),
                });
            }
        }

        let entities = self.store.list()?;
        let episodes = self.store.episodes(None, None)?;
        let as_of = now.unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0)
        });

        let snapshot = MemorySnapshotV1 {
            schema_version: CURRENT_MEMORY_SCHEMA_VERSION,
            as_of,
            registries: Some(self.store.registries().clone()),
            entities: entities.clone(),
            episodes: if episodes.is_empty() {
                None
            } else {
                Some(episodes)
            },
            meta: None,
        };

        let serialized = serialize_snapshot(&snapshot)?;
        self.atomic_write_file(&serialized)?;
        self.last_observed_content = Some(Some(serialized));

        Ok(PushResult {
            ok: true,
            pushed_count: entities.len(),
            commit: None,
            error: None,
        })
    }

    fn reconcile(&mut self, now: Option<i64>) -> Result<ReconcileResult, SyncError> {
        let pull_res = self.pull()?;
        if !pull_res.ok {
            return Ok(ReconcileResult {
                ok: false,
                pulled_count: 0,
                pushed_count: 0,
                total_count: pull_res.local_total,
                commit: None,
                error: pull_res.error,
            });
        }

        let push_res = self.push(now)?;
        let final_count = self.store.list()?.len();

        Ok(ReconcileResult {
            ok: push_res.ok,
            pulled_count: pull_res.pulled_count,
            pushed_count: push_res.pushed_count,
            total_count: final_count,
            commit: None,
            error: push_res.error,
        })
    }
}
