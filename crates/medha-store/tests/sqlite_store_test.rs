use medha_core::types::{EntityKey, LifecycleStatus, SignalSpec};
use medha_store::{
    EpisodeInput, EpisodePayload, OpenResult, SqliteStore, SqliteStoreOptions, StorePort,
};
use tempfile::NamedTempFile;

fn sample_signal_spec() -> SignalSpec {
    SignalSpec {
        name: "APPLY".to_string(),
        value: 1.0,
        counts_as_trial: true,
        counts_as_success: true,
        description: Some("Applied and verified".to_string()),
    }
}

#[test]
fn test_sqlite_store_basic_lifecycle() {
    let tmp = NamedTempFile::new().expect("temp file");
    let path = tmp.path().to_str().expect("path string").to_string();

    let mut store = SqliteStore::new(SqliteStoreOptions {
        path: path.clone(),
        registries: None,
        resilient_replay: false,
    });

    let open_res = store.open().expect("open success");
    assert_eq!(open_res, OpenResult::Ok);
    assert!(store.is_open());

    // Meta operations
    store.set_meta("test_key", "test_value").expect("set meta");
    let meta_val = store.get_meta("test_key").expect("get meta");
    assert_eq!(meta_val.as_deref(), Some("test_value"));

    // Append signal
    let key = EntityKey::new("", "rule", "no-console-log");
    let input = EpisodeInput {
        key: key.clone(),
        at: 1700000000000,
        author: Some("agent-1".to_string()),
        payload: EpisodePayload::Signal {
            spec: sample_signal_spec(),
            anchors: None,
            ensure: true,
            run_ref: None,
            note: Some("Testing rule".to_string()),
            updater: None,
            weight: None,
            case_id: None,
        },
    };

    let append_res = store.append(input).expect("append success");
    assert_eq!(append_res.episode.seq, 0);
    assert_eq!(append_res.episode.key.id, "no-console-log");

    let state = append_res.state.expect("state present");
    assert_eq!(state.evidence.k, 1.0);
    assert_eq!(state.evidence.n, 1.0);
    assert_eq!(state.status, LifecycleStatus::Probation);

    // Append guard
    let guard_input = EpisodeInput {
        key: key.clone(),
        at: 1700000005000,
        author: Some("human-reviewer".to_string()),
        payload: EpisodePayload::Guard {
            ok: true,
            kind: Some("review".to_string()),
            ensure: true,
            note: Some("Passed code review".to_string()),
        },
    };
    let guard_res = store.append(guard_input).expect("append guard");
    assert_eq!(guard_res.episode.seq, 1);
    let guard_state = guard_res.state.expect("state after guard");
    assert_eq!(guard_state.guard.kind, "review");
    assert_eq!(guard_state.guard.last_ok, Some(true));

    // Get and List
    let fetched = store.get(&key).expect("get").expect("found");
    assert_eq!(fetched.key.id, "no-console-log");

    let all = store.list().expect("list");
    assert_eq!(all.len(), 1);

    // Read episodes
    let eps = store.episodes(None, None).expect("episodes");
    assert_eq!(eps.len(), 2);
    assert_eq!(eps[0].seq, 0);
    assert_eq!(eps[1].seq, 1);

    // Close and reopen to verify SQLite persistence and rebuild
    store.close().expect("close");
    assert!(!store.is_open());

    let mut store2 = SqliteStore::new(SqliteStoreOptions {
        path: path.clone(),
        registries: None,
        resilient_replay: false,
    });
    let reopen_res = store2.open().expect("reopen");
    assert_eq!(reopen_res, OpenResult::Ok);

    let re_eps = store2.episodes(None, None).expect("episodes after reopen");
    assert_eq!(re_eps.len(), 2);

    let re_state = store2.get(&key).expect("get after reopen").expect("found");
    assert_eq!(re_state.evidence.k, 1.0);
    assert_eq!(re_state.guard.last_ok, Some(true));
}

#[test]
fn test_sqlite_store_retraction() {
    let tmp = NamedTempFile::new().expect("temp file");
    let path = tmp.path().to_str().expect("path string").to_string();

    let mut store = SqliteStore::new(SqliteStoreOptions {
        path,
        registries: None,
        resilient_replay: false,
    });
    store.open().expect("open");

    let key = EntityKey::new("", "rule", "flaky-rule");

    // 1. First signal
    store
        .append(EpisodeInput {
            key: key.clone(),
            at: 1000,
            author: None,
            payload: EpisodePayload::Signal {
                spec: sample_signal_spec(),
                anchors: None,
                ensure: true,
                run_ref: None,
                note: None,
                updater: None,
                weight: None,
                case_id: None,
            },
        })
        .expect("append 0");

    // 2. Second signal
    store
        .append(EpisodeInput {
            key: key.clone(),
            at: 2000,
            author: None,
            payload: EpisodePayload::Signal {
                spec: sample_signal_spec(),
                anchors: None,
                ensure: true,
                run_ref: None,
                note: None,
                updater: None,
                weight: None,
                case_id: None,
            },
        })
        .expect("append 1");

    let state_before = store.get(&key).unwrap().unwrap();
    assert_eq!(state_before.evidence.k, 2.0);

    // 3. Retract seq 1
    store
        .append(EpisodeInput {
            key: key.clone(),
            at: 3000,
            author: Some("admin".to_string()),
            payload: EpisodePayload::Retract {
                target_seq: 1,
                reason: "Misattribution".to_string(),
            },
        })
        .expect("append retract");

    let state_after = store.get(&key).unwrap().unwrap();
    // After retracting seq 1, only seq 0 remains in the projection fold
    assert_eq!(state_after.evidence.k, 1.0);
}
