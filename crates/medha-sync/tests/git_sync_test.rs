use medha_core::types::{EntityKey, SignalSpec};
use medha_store::{EpisodeInput, EpisodePayload, MemoryStore, StorePort};
use medha_sync::{GitRefSyncAdapter, SyncPort, SyncState, DEFAULT_MEDHA_REF};
use std::process::Command;
use tempfile::tempdir;

fn run_cmd(dir: &std::path::Path, program: &str, args: &[&str]) {
    let output = Command::new(program)
        .current_dir(dir)
        .args(args)
        .output()
        .expect("command runs");
    assert!(
        output.status.success(),
        "Command {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
}

fn sample_signal(id: &str, at: i64) -> EpisodeInput {
    EpisodeInput {
        key: EntityKey::new("", "rule", id),
        at,
        author: None,
        payload: EpisodePayload::Signal {
            spec: SignalSpec {
                name: "APPLY".to_string(),
                value: 1.0,
                counts_as_trial: true,
                counts_as_success: true,
                description: Some("Applied".to_string()),
            },
            anchors: None,
            ensure: true,
            run_ref: None,
            note: None,
            updater: None,
            weight: None,
            case_id: None,
        },
    }
}

#[test]
fn test_git_sync_lifecycle_and_ref_push() {
    let dir = tempdir().expect("tempdir");
    let repo_path = dir.path();

    // Init real git repository
    run_cmd(repo_path, "git", &["init"]);
    run_cmd(repo_path, "git", &["config", "user.name", "Medha Test"]);
    run_cmd(repo_path, "git", &["config", "user.email", "test@medha.local"]);
    run_cmd(
        repo_path,
        "git",
        &["commit", "--allow-empty", "-m", "initial commit"],
    );

    let mut store = MemoryStore::new(None);
    store.open().expect("open ok");

    let adapter = GitRefSyncAdapter::new(store, repo_path);
    assert!(adapter.is_git_repo());

    // Initially uninitialized
    let status = adapter.status().expect("status ok");
    assert_eq!(status.state, SyncState::Uninitialized);
    assert_eq!(status.ref_name, Some(DEFAULT_MEDHA_REF.to_string()));

    // Append and push
    let mut store = adapter.store().clone(); // Or take store back
    store.append(sample_signal("rule-git-1", 1000)).expect("append ok");

    let mut adapter = GitRefSyncAdapter::new(store, repo_path);
    let push_res = adapter.push(Some(1000)).expect("push ok");
    assert!(push_res.ok);
    assert!(push_res.commit.is_some());

    let commit_sha = push_res.commit.unwrap();
    let ref_commit = adapter.get_ref_commit(DEFAULT_MEDHA_REF);
    assert_eq!(ref_commit, Some(commit_sha));

    // Read back snapshot
    let snapshot = adapter
        .read_snapshot_from_ref(DEFAULT_MEDHA_REF)
        .expect("snapshot exists");
    assert_eq!(snapshot.schema_version, 1);
    assert_eq!(snapshot.entities.len(), 1);
    assert_eq!(snapshot.entities[0].key.id, "rule-git-1");

    // Status is now Synced / Ahead
    let status = adapter.status().expect("status ok");
    assert!(status.state == SyncState::Synced || status.state == SyncState::Ahead);
    assert_eq!(status.local_count, 1);
}

#[test]
fn test_git_sync_two_repos_reconcile() {
    let dir_a = tempdir().expect("tempdir a");
    let dir_b = tempdir().expect("tempdir b");
    let repo_a = dir_a.path();
    let repo_b = dir_b.path();

    // Init repo A
    run_cmd(repo_a, "git", &["init"]);
    run_cmd(repo_a, "git", &["config", "user.name", "User A"]);
    run_cmd(repo_a, "git", &["config", "user.email", "a@test.local"]);
    run_cmd(repo_a, "git", &["commit", "--allow-empty", "-m", "init a"]);

    // Clone or init repo B with remote pointing to A
    run_cmd(repo_b, "git", &["init"]);
    run_cmd(repo_b, "git", &["config", "user.name", "User B"]);
    run_cmd(repo_b, "git", &["config", "user.email", "b@test.local"]);
    run_cmd(repo_b, "git", &["commit", "--allow-empty", "-m", "init b"]);
    let remote_url = repo_a.to_str().unwrap().replace('\\', "/");
    run_cmd(repo_b, "git", &["remote", "add", "origin", &remote_url]);

    // Store A records rule-a and pushes to ref
    let mut store_a = MemoryStore::new(None);
    store_a.open().expect("open a");
    store_a.append(sample_signal("rule-a", 1000)).expect("append a");
    let mut adapter_a = GitRefSyncAdapter::new(store_a, repo_a);
    let push_a = adapter_a.push(Some(1000)).expect("push a");
    assert!(push_a.ok);

    // Store B records rule-b
    let mut store_b = MemoryStore::new(None);
    store_b.open().expect("open b");
    store_b.append(sample_signal("rule-b", 2000)).expect("append b");
    let mut adapter_b = GitRefSyncAdapter::new(store_b, repo_b);

    // B reconciles with A (fetches remote ref, merges episodes, writes ref)
    let rec_b = adapter_b.reconcile(Some(2000)).expect("reconcile b");
    assert!(rec_b.ok);

    let list_b = adapter_b.store().list().expect("list b");
    let mut ids_b: Vec<String> = list_b.iter().map(|e| e.key.id.clone()).collect();
    ids_b.sort();
    assert_eq!(ids_b, vec!["rule-a", "rule-b"]);
}

