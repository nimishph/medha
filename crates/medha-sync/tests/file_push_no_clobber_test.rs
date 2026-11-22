//! Regression (0.8.0-alpha.1 field test): two replicas pushing to one sync file from fresh
//! adapters (as two `medha sync push` processes do) must not overwrite each other's evidence.

use medha_core::types::{EntityKey, SignalSpec};
use medha_store::{EpisodeInput, EpisodePayload, MemoryStore, StorePort};
use medha_sync::{FileSyncAdapter, SyncPort};
use tempfile::tempdir;

fn signal(id: &str, at: i64) -> EpisodeInput {
    EpisodeInput {
        key: EntityKey::new("", "rule", id),
        at,
        author: None,
        sig: None,
        payload: EpisodePayload::Signal {
            spec: SignalSpec {
                name: "APPLY".to_string(),
                value: 1.0,
                counts_as_trial: true,
                counts_as_success: true,
                description: None,
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
fn sequential_pushes_from_fresh_adapters_merge() {
    let dir = tempdir().expect("tmp");
    let file = dir.path().join("shared.json");

    let mut a = MemoryStore::new(None);
    a.open().expect("open");
    for i in 0..3 {
        a.append(signal("from-a", 1000 + i)).expect("append");
    }
    let mut b = MemoryStore::new(None);
    b.open().expect("open");
    b.append(signal("from-b", 2000)).expect("append");

    // Each push uses a brand-new adapter, like a separate CLI process.
    assert!(
        FileSyncAdapter::new(&file)
            .push(&a, Some(3000))
            .expect("push a")
            .ok
    );
    assert!(
        FileSyncAdapter::new(&file)
            .push(&b, Some(3001))
            .expect("push b")
            .ok
    );

    // B pulls and must now see A's evidence; A pulls and sees B's.
    FileSyncAdapter::new(&file).pull(&mut b).expect("pull b");
    FileSyncAdapter::new(&file).pull(&mut a).expect("pull a");
    for store in [&a, &b] {
        let keys: Vec<String> = store
            .list()
            .expect("list")
            .iter()
            .map(|s| s.key.id.clone())
            .collect();
        assert!(keys.contains(&"from-a".to_string()), "lost A: {keys:?}");
        assert!(keys.contains(&"from-b".to_string()), "lost B: {keys:?}");
        assert_eq!(store.episodes(None, None).expect("eps").len(), 4);
    }
}

#[test]
fn push_refuses_to_overwrite_unreadable_file() {
    let dir = tempdir().expect("tmp");
    let file = dir.path().join("shared.json");
    std::fs::write(&file, "not json").expect("write");
    let mut a = MemoryStore::new(None);
    a.open().expect("open");
    a.append(signal("x", 1)).expect("append");
    assert!(FileSyncAdapter::new(&file).push(&a, Some(2)).is_err());
    assert_eq!(std::fs::read_to_string(&file).expect("read"), "not json");
}
