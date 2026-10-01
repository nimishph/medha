use medha_core::types::{EntityKey, SignalSpec};
use medha_store::{EpisodeInput, EpisodePayload, MemoryStore, StorePort};
use medha_sync::{FileSyncAdapter, SyncPort, SyncState};
use tempfile::tempdir;

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
fn test_file_sync_uninitialized_when_file_missing() {
    let mut store = MemoryStore::new(None);
    store.open().expect("open ok");

    let dir = tempdir().expect("tempdir");
    let file_path = dir.path().join("sync.json");

    let adapter = FileSyncAdapter::new(store, &file_path);
    let status = adapter.status().expect("status ok");

    assert_eq!(status.state, SyncState::Uninitialized);
    assert_eq!(status.local_count, 0);
}

#[test]
fn test_file_sync_push_and_synced_status() {
    let mut store = MemoryStore::new(None);
    store.open().expect("open ok");
    store
        .append(sample_signal("rule-1", 1000))
        .expect("append ok");

    let dir = tempdir().expect("tempdir");
    let file_path = dir.path().join("sync.json");

    let mut adapter = FileSyncAdapter::new(store, &file_path);
    let push_res = adapter.push(Some(1000)).expect("push ok");

    assert!(push_res.ok);
    assert_eq!(push_res.pushed_count, 1);

    let status = adapter.status().expect("status ok");
    assert_eq!(status.state, SyncState::Synced);
    assert_eq!(status.local_count, 1);
    assert_eq!(status.remote_count, Some(1));

    let peek_snap = adapter.peek().expect("peek ok").expect("snapshot exists");
    assert_eq!(peek_snap.schema_version, 1);
    assert_eq!(peek_snap.entities.len(), 1);
    assert_eq!(peek_snap.entities[0].key.id, "rule-1");
}

#[test]
fn test_file_sync_reconcile_and_convergence() {
    let mut store_a = MemoryStore::new(None);
    store_a.open().expect("open ok");
    store_a
        .append(sample_signal("rule-a", 1000))
        .expect("append ok");

    let mut store_b = MemoryStore::new(None);
    store_b.open().expect("open ok");
    store_b
        .append(sample_signal("rule-b", 2000))
        .expect("append ok");

    let dir = tempdir().expect("tempdir");
    let file_path = dir.path().join("shared-sync.json");

    let mut adapter_a = FileSyncAdapter::new(store_a, &file_path);
    let mut adapter_b = FileSyncAdapter::new(store_b, &file_path);

    // A pushes to shared file
    adapter_a.push(Some(1000)).expect("push ok");

    // B reconciles: pulls A, merges, pushes merged
    let rec_b = adapter_b.reconcile(Some(2000)).expect("reconcile ok");
    assert!(rec_b.ok);

    // A reconciles: pulls merged
    let rec_a = adapter_a.reconcile(Some(3000)).expect("reconcile ok");
    assert!(rec_a.ok);

    // Both stores now have both entities
    let list_a = adapter_a.store().list().expect("list ok");
    let list_b = adapter_b.store().list().expect("list ok");

    let mut ids_a: Vec<String> = list_a.iter().map(|e| e.key.id.clone()).collect();
    let mut ids_b: Vec<String> = list_b.iter().map(|e| e.key.id.clone()).collect();
    ids_a.sort();
    ids_b.sort();

    assert_eq!(ids_a, vec!["rule-a", "rule-b"]);
    assert_eq!(ids_b, vec!["rule-a", "rule-b"]);
}
