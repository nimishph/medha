use crate::errors::SyncError;
use crate::merge::merge_episodes;
use crate::snapshot::{
    migrate_snapshot, serialize_snapshot, MemorySnapshotV1, CURRENT_MEMORY_SCHEMA_VERSION,
};
use crate::traits::{PullResult, PushResult, ReconcileResult, SyncPort, SyncState, SyncStatus};
use medha_store::StorePort;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub const DEFAULT_MEDHA_REF: &str = "refs/medha/memory";
pub const LEGACY_MEDHA_REF: &str = "refs/sutra/medha/memory";
pub const DEFAULT_REMOTE: &str = "origin";

pub struct GitRefSyncAdapter<S: StorePort> {
    store: S,
    root_dir: PathBuf,
    ref_name: String,
    remote: String,
    read_refs: Vec<String>,
}

impl<S: StorePort> GitRefSyncAdapter<S> {
    pub fn new(store: S, root_dir: impl AsRef<Path>) -> Self {
        Self {
            store,
            root_dir: root_dir.as_ref().to_path_buf(),
            ref_name: DEFAULT_MEDHA_REF.to_string(),
            remote: DEFAULT_REMOTE.to_string(),
            read_refs: vec![LEGACY_MEDHA_REF.to_string()],
        }
    }

    pub fn with_ref_and_remote(
        store: S,
        root_dir: impl AsRef<Path>,
        ref_name: impl Into<String>,
        remote: impl Into<String>,
    ) -> Self {
        Self {
            store,
            root_dir: root_dir.as_ref().to_path_buf(),
            ref_name: ref_name.into(),
            remote: remote.into(),
            read_refs: vec![LEGACY_MEDHA_REF.to_string()],
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

    pub fn run_git(
        &self,
        args: &[&str],
        stdin_data: Option<&str>,
    ) -> Result<(String, String), SyncError> {
        let mut cmd = Command::new("git");
        cmd.current_dir(&self.root_dir);
        cmd.args(args);
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        if stdin_data.is_some() {
            cmd.stdin(Stdio::piped());
        }

        let mut child = cmd.spawn()?;

        if let Some(data) = stdin_data {
            if let Some(mut stdin) = child.stdin.take() {
                stdin.write_all(data.as_bytes())?;
            }
        }

        let output = child.wait_with_output()?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

        if !output.status.success() {
            return Err(SyncError::Git(format!(
                "git {:?} failed (exit code {:?}): {}",
                args,
                output.status.code(),
                stderr
            )));
        }

        Ok((stdout, stderr))
    }

    pub fn is_git_repo(&self) -> bool {
        match self.run_git(&["rev-parse", "--is-inside-work-tree"], None) {
            Ok((stdout, _)) => stdout == "true",
            Err(_) => false,
        }
    }

    pub fn get_ref_commit(&self, ref_name: &str) -> Option<String> {
        self.run_git(&["rev-parse", "--verify", ref_name], None)
            .ok()
            .map(|(out, _)| out)
            .filter(|s| !s.is_empty())
    }

    pub fn get_remote_ref_commit(&self, remote: &str, ref_name: &str) -> Option<String> {
        if let Ok((stdout, _)) = self.run_git(&["ls-remote", remote, ref_name], None) {
            if let Some(sha) = stdout.split_whitespace().next() {
                if !sha.is_empty() {
                    return Some(sha.to_string());
                }
            }
        }
        None
    }

    pub fn get_merge_base_commit(&self, a: &str, b: &str) -> Option<String> {
        self.run_git(&["merge-base", a, b], None)
            .ok()
            .map(|(out, _)| out)
            .filter(|s| !s.is_empty())
    }

    pub fn read_snapshot_from_ref(&self, ref_name: &str) -> Option<MemorySnapshotV1> {
        let target = format!("{}:snapshot.json", ref_name);
        if let Ok((stdout, _)) = self.run_git(&["cat-file", "-p", &target], None) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&stdout) {
                return migrate_snapshot(val).ok();
            }
        }
        None
    }

    pub fn write_snapshot_to_ref(
        &self,
        snapshot: &MemorySnapshotV1,
        message: &str,
        parents: &[String],
    ) -> Result<String, SyncError> {
        let json_str = serialize_snapshot(snapshot)?;

        // 1. Hash object
        let (blob_sha, _) = self.run_git(&["hash-object", "-w", "--stdin"], Some(&json_str))?;

        // 2. Make tree
        let tree_input = format!("100644 blob {}\tsnapshot.json\n", blob_sha);
        let (tree_sha, _) = self.run_git(&["mktree"], Some(&tree_input))?;

        // 3. Commit tree
        let mut commit_args = vec!["commit-tree", &tree_sha];
        for p in parents {
            commit_args.push("-p");
            commit_args.push(p);
        }
        commit_args.push("-m");
        commit_args.push(message);

        let (commit_sha, _) = self.run_git(&commit_args, None)?;

        // 4. Update ref
        self.run_git(&["update-ref", &self.ref_name, &commit_sha], None)?;

        Ok(commit_sha)
    }

    fn get_tracking_ref(&self, remote: &str, ref_name: &str) -> String {
        let suffix = ref_name.strip_prefix("refs/").unwrap_or(ref_name);
        format!("refs/remotes/{}/{}", remote, suffix)
    }

    pub fn fetch_remote_ref(
        &self,
        remote: &str,
        ref_name: &str,
    ) -> Result<Option<String>, SyncError> {
        let tracking = self.get_tracking_ref(remote, ref_name);
        let ref_spec = format!("{}:{}", ref_name, tracking);
        match self.run_git(&["fetch", remote, &ref_spec], None) {
            Ok(_) => Ok(self.get_ref_commit(&tracking)),
            Err(e) => {
                let err_str = e.to_string();
                if err_str.contains("couldn't find remote ref")
                    || err_str.contains("fatal: couldn't find")
                {
                    Ok(None)
                } else {
                    Err(e)
                }
            }
        }
    }

    pub fn push_remote_ref(
        &self,
        remote: &str,
        ref_name: &str,
        force: bool,
    ) -> Result<(), SyncError> {
        let spec = if force {
            format!("+{}:{}", ref_name, ref_name)
        } else {
            format!("{}:{}", ref_name, ref_name)
        };
        self.run_git(&["push", remote, &spec], None)?;
        Ok(())
    }
}

impl<S: StorePort> SyncPort for GitRefSyncAdapter<S> {
    fn name(&self) -> &str {
        "git-ref"
    }

    fn status(&self) -> Result<SyncStatus, SyncError> {
        let local_states = self.store.list()?;
        let local_count = local_states.len();

        if !self.is_git_repo() {
            return Ok(SyncStatus {
                state: SyncState::Uninitialized,
                local_count,
                remote_count: None,
                local_head: None,
                remote_head: None,
                ref_name: Some(self.ref_name.clone()),
                remote_url: None,
                message: Some("Directory is not a git repository".to_string()),
            });
        }

        let mut active_ref = self.ref_name.clone();
        for candidate in std::iter::once(&self.ref_name).chain(self.read_refs.iter()) {
            if self.get_ref_commit(candidate).is_some()
                || self
                    .get_remote_ref_commit(&self.remote, candidate)
                    .is_some()
            {
                active_ref = candidate.clone();
                break;
            }
        }

        let local_commit = self.get_ref_commit(&active_ref);
        let remote_commit = self.get_remote_ref_commit(&self.remote, &active_ref);

        if local_commit.is_none() && remote_commit.is_none() {
            return Ok(SyncStatus {
                state: SyncState::Uninitialized,
                local_count,
                remote_count: None,
                local_head: None,
                remote_head: None,
                ref_name: Some(self.ref_name.clone()),
                remote_url: None,
                message: None,
            });
        }

        let state = match (&local_commit, &remote_commit) {
            (None, Some(_)) => SyncState::Behind,
            (Some(_), None) => SyncState::Ahead,
            (Some(loc), Some(rem)) => {
                if loc == rem {
                    SyncState::Synced
                } else if let Some(base) = self.get_merge_base_commit(loc, rem) {
                    if &base == loc {
                        SyncState::Behind
                    } else if &base == rem {
                        SyncState::Ahead
                    } else {
                        SyncState::Diverged
                    }
                } else {
                    SyncState::Diverged
                }
            }
            (None, None) => SyncState::Uninitialized,
        };

        Ok(SyncStatus {
            state,
            local_count,
            remote_count: None,
            local_head: local_commit,
            remote_head: remote_commit,
            ref_name: Some(active_ref),
            remote_url: None,
            message: None,
        })
    }

    fn peek(&self) -> Result<Option<MemorySnapshotV1>, SyncError> {
        if !self.is_git_repo() {
            return Ok(None);
        }
        for r in std::iter::once(&self.ref_name).chain(self.read_refs.iter()) {
            if let Some(snapshot) = self.read_snapshot_from_ref(r) {
                return Ok(Some(snapshot));
            }
        }
        Ok(None)
    }

    fn pull(&mut self) -> Result<PullResult, SyncError> {
        let local_states = self.store.list()?;
        let local_total = local_states.len();

        if !self.is_git_repo() {
            return Ok(PullResult {
                ok: false,
                updated: false,
                pulled_count: 0,
                local_total,
                error: Some("Not a git repository".to_string()),
            });
        }

        // Try reading snapshots from current ref and legacy refs
        let mut snapshots = Vec::new();
        // If remote tracking ref exists or can be fetched
        if let Ok(Some(remote_sha)) = self.fetch_remote_ref(&self.remote, &self.ref_name) {
            if let Some(snap) = self.read_snapshot_from_ref(&remote_sha) {
                snapshots.push(snap);
            }
        } else if let Some(snap) = self.read_snapshot_from_ref(&self.ref_name) {
            snapshots.push(snap);
        }

        for legacy in &self.read_refs {
            if let Some(snap) = self.read_snapshot_from_ref(legacy) {
                snapshots.push(snap);
            }
        }

        let local_episodes = self.store.episodes(None, None)?;
        let mut merged_episodes = local_episodes.clone();

        for snap in &snapshots {
            if let Some(ref eps) = snap.episodes {
                if !eps.is_empty() {
                    merged_episodes = merge_episodes(&merged_episodes, eps);
                }
            }
        }

        let mut updated = false;
        let mut pulled_count = 0;
        if merged_episodes.len() != local_episodes.len() {
            self.store.replace_log(&merged_episodes)?;
            self.store.rebuild()?;
            updated = true;
            pulled_count = merged_episodes.len() - local_episodes.len();
        }

        let updated_states = self.store.list()?;
        Ok(PullResult {
            ok: true,
            updated,
            pulled_count,
            local_total: updated_states.len(),
            error: None,
        })
    }

    fn push(&mut self, now: Option<i64>) -> Result<PushResult, SyncError> {
        if !self.is_git_repo() {
            return Ok(PushResult {
                ok: false,
                pushed_count: 0,
                commit: None,
                error: Some("Not a git repository".to_string()),
            });
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

        let mut parents = Vec::new();
        if let Some(local_commit) = self.get_ref_commit(&self.ref_name) {
            parents.push(local_commit);
        }

        let commit = self.write_snapshot_to_ref(&snapshot, "Medha memory push", &parents)?;

        // Try pushing to remote if configured
        let _ = self.push_remote_ref(&self.remote, &self.ref_name, false);

        Ok(PushResult {
            ok: true,
            pushed_count: entities.len(),
            commit: Some(commit),
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
            commit: push_res.commit,
            error: push_res.error,
        })
    }
}
