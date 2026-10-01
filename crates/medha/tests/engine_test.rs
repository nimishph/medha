use medha::core::types::{EntityKey, LifecycleStatus};
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
