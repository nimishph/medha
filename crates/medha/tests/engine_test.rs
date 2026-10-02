use medha::config::MedhaConfig;
use medha::core::types::{EntityKey, LifecycleStatus};
use medha::store::{MemoryStore, StorePort};
use medha::{GuardInput, MedhaEngine, RecordInput};
use tempfile::NamedTempFile;

#[test]
fn test_medha_engine_memory_lifecycle() {
    let mut engine = MedhaEngine::open_in_memory().expect("open in memory");

    let key = EntityKey::new("", "rule", "no-console-log");

    // 1. Propose
    let prop_res = engine
        .propose(
            &key,
            "review",
            Some(0.5),
            Some("Prevent console.log".to_string()),
            1000,
        )
        .expect("propose");
    assert_eq!(prop_res.episode.seq, 0);

    // Initial hint
    let initial_hint = engine.hint(&key, 1000).expect("hint");
    assert_eq!(initial_hint.status, LifecycleStatus::Probation);
    assert_eq!(initial_hint.trust, 0.0);

    // 2. Record APPLY
    let rec_res = engine
        .record(RecordInput {
            key: key.clone(),
            signal: "APPLY".to_string(),
            at: 2000,
            author: Some("agent-1".to_string()),
            anchors: None,
            run_ref: None,
            note: None,
            case_id: None,
        })
        .expect("record apply");
    assert_eq!(rec_res.episode.seq, 1);

    // 3. Simulate REJECT_RULE
    let sim = engine
        .simulate(&key, "REJECT_RULE", 2500)
        .expect("simulate");
    assert_eq!(sim.signal, "REJECT_RULE");
    assert!(sim.trust_delta <= 0.0);

    // 4. Guard OK
    let guard_res = engine
        .guard(GuardInput {
            key: key.clone(),
            ok: true,
            kind: Some("linter".to_string()),
            at: 3000,
            author: Some("ci".to_string()),
            note: None,
        })
        .expect("guard");
    assert_eq!(guard_res.episode.seq, 2);

    // 5. Show
    let show = engine.show(&key, 3500).expect("show");
    assert!(show.known);
    assert_eq!(show.recent_episodes.len(), 3);

    // 6. Explain threshold
    let expl = engine.explain_threshold(&key, 3500).expect("explain");
    assert_eq!(expl.gates.len(), 3);
    assert_eq!(expl.gates[0].name, "trusted");
    assert_eq!(expl.gates[1].name, "active");

    // 7. Compaction
    let comp = engine.compact(4000).expect("compact");
    assert_eq!(comp.before_count, 3);
    assert_eq!(comp.after_count, 1);

    // 8. Preflight
    let pre = engine.preflight().expect("preflight");
    assert!(pre.ok);
    assert_eq!(pre.total_entities, 1);
}

#[test]
fn test_medha_engine_sqlite_persistence() {
    let tmp = NamedTempFile::new().expect("temp file");
    let path = tmp.path().to_str().expect("path string").to_string();

    let key = EntityKey::new("", "rule", "sqlite-rule");

    {
        let mut engine = MedhaEngine::open_sqlite(&path).expect("open sqlite");
        engine
            .record(RecordInput {
                key: key.clone(),
                signal: "APPLY".to_string(),
                at: 1000,
                author: None,
                anchors: None,
                run_ref: None,
                note: None,
                case_id: None,
            })
            .expect("record");
    }

    // Reopen and verify data persisted
    {
        let engine = MedhaEngine::open_sqlite(&path).expect("reopen sqlite");
        let fetched = engine.get(&key).expect("get").expect("found");
        assert_eq!(fetched.evidence.k, 1.0);
        assert_eq!(fetched.evidence.n, 1.0);
    }
}

#[test]
fn test_medha_engine_pack_and_remove_episode() {
    let mut engine = MedhaEngine::open_in_memory().expect("open memory");
    let key1 = EntityKey::new("", "rule", "rule-first");
    let key2 = EntityKey::new("", "rule", "rule-second");

    let rec1 = engine
        .record(RecordInput {
            key: key1.clone(),
            signal: "APPLY".to_string(),
            at: 1000,
            author: None,
            anchors: None,
            run_ref: None,
            note: None,
            case_id: None,
        })
        .expect("rec1");
    assert_eq!(rec1.episode.seq, 0);

    let rec2 = engine
        .record(RecordInput {
            key: key2.clone(),
            signal: "APPLY".to_string(),
            at: 2000,
            author: None,
            anchors: None,
            run_ref: None,
            note: None,
            case_id: None,
        })
        .expect("rec2");
    assert_eq!(rec2.episode.seq, 1);

    // Test pack
    let pack_opts = medha::EnginePackOptions {
        budget: 500,
        kind: Some("rule".to_string()),
        namespace: None,
        exploration_ratio: 0.15,
        seed: None,
        min_trust: 0.0,
        allow_quarantined: false,
        allow_retired: false,
    };
    let outcome = engine.pack(pack_opts, 3000).expect("pack");
    assert_eq!(outcome.selected.len(), 2);
    assert!(outcome.total_cost <= 500);

    // Test remove_episode
    engine.remove_episode(0).expect("remove ep 0");
    let eps = engine.store().episodes(None, None).expect("episodes");
    assert_eq!(eps.len(), 1);
    assert_eq!(eps[0].seq, 0);
    assert_eq!(eps[0].key, key2);
}

#[test]
fn test_medha_engine_file_sync_reconcile() {
    let dir = tempfile::tempdir().expect("tempdir");
    let sync_path = dir.path().join("sync-shared.json");

    let mut engine1 =
        MedhaEngine::with_file_sync(MemoryStore::new(None), &sync_path, MedhaConfig::default());
    let mut engine2 =
        MedhaEngine::with_file_sync(MemoryStore::new(None), &sync_path, MedhaConfig::default());

    let key_a = EntityKey::new("", "rule", "rule-a");
    let key_b = EntityKey::new("", "rule", "rule-b");

    engine1
        .record(RecordInput {
            key: key_a.clone(),
            signal: "APPLY".to_string(),
            at: 1000,
            author: None,
            anchors: None,
            run_ref: None,
            note: None,
            case_id: None,
        })
        .expect("record on 1");

    let push_res = engine1.sync_push(Some(1000)).expect("push 1");
    assert!(push_res.ok);

    let pull_res = engine2.sync_pull().expect("pull 2");
    assert!(pull_res.ok);
    assert_eq!(pull_res.pulled_count, 1);

    engine2
        .record(RecordInput {
            key: key_b.clone(),
            signal: "APPLY".to_string(),
            at: 2000,
            author: None,
            anchors: None,
            run_ref: None,
            note: None,
            case_id: None,
        })
        .expect("record on 2");

    let rec_res = engine2.sync_reconcile(Some(2000)).expect("reconcile 2");
    assert!(rec_res.ok);

    let pull_1 = engine1.sync_pull().expect("pull 1");
    assert!(pull_1.ok);

    // Both engines now have both entities
    let list1 = engine1.list().expect("list 1");
    let list2 = engine2.list().expect("list 2");
    assert_eq!(list1.len(), 2);
    assert_eq!(list2.len(), 2);
}
