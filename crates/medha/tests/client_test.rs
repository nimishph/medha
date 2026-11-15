use medha::client::{MedhaClient, MedhaClientBuilder};
use medha::core::types::EntityKey;
use medha::store::types::ContextTargets;
use tempfile::tempdir;

#[test]
fn test_rust_client_in_memory_lifecycle() {
    let mut client = MedhaClient::in_memory().expect("failed to open in-memory client");
    assert_eq!(client.default_actor(), None);

    let entities = client.list().expect("failed to list entities");
    assert_eq!(entities.len(), 0);

    let status = client.status().expect("failed to get status");
    assert!(status.initialized);
    assert_eq!(status.total_entities, 0);
    assert_eq!(status.total_episodes, 0);

    // Define a rule
    let key = client
        .define_rule(
            "strict-types",
            "Always specify explicit types",
            Some("Enforces type safety across modules"),
            Some("style"),
            Some(ContextTargets {
                files: Some(vec!["src/**/*.rs".to_string()]),
                languages: Some(vec!["rust".to_string()]),
                keywords: Some(vec!["type".to_string()]),
            }),
        )
        .expect("failed to define rule");

    assert_eq!(key.kind, "rule");
    assert_eq!(key.namespace, "style");
    assert_eq!(key.id, "strict-types");

    let state = client
        .get(&key)
        .expect("get failed")
        .expect("missing state");
    assert_eq!(state.evidence.n, 1.0);
    assert_eq!(state.evidence.k, 1.0);

    let show = client.show(&key).expect("show failed");
    assert!(show.known);
    assert_eq!(show.hint.trials, 1.0);
}

#[test]
fn test_rust_client_acceptance_and_rejection() {
    let mut client = MedhaClientBuilder::new()
        .with_actor("reviewer-alice")
        .build_in_memory()
        .expect("failed to build client");

    assert_eq!(client.default_actor(), Some("reviewer-alice"));

    let key = client
        .define_rule(
            "no-unwrap",
            "Avoid unwrap in production",
            None,
            Some("safety"),
            None,
        )
        .expect("define failed");

    let initial = client.show(&key).expect("show failed");
    let initial_trust = initial.hint.trust;

    // Record acceptances
    for _ in 0..3 {
        client
            .record_acceptance(&key, Some("Followed in PR"))
            .expect("acceptance failed");
    }

    let accepted = client.show(&key).expect("show failed");
    assert_eq!(accepted.hint.trials, 4.0);
    assert!(accepted.hint.trust > initial_trust);

    // Record rejections
    for _ in 0..2 {
        client
            .record_rejection(&key, Some("False positive"))
            .expect("rejection failed");
    }

    let rejected = client.show(&key).expect("show failed");
    assert_eq!(rejected.hint.trials, 6.0);
    assert!(rejected.hint.trust < accepted.hint.trust);
}

#[test]
fn test_rust_client_prompt_packing_and_context_hints() {
    let mut client = MedhaClient::in_memory().expect("failed to open");

    client
        .define_rule(
            "sql-param",
            "Use parameterized SQL",
            Some("security pattern"),
            Some("security"),
            Some(ContextTargets {
                files: Some(vec!["src/db/**/*.rs".to_string()]),
                languages: Some(vec!["rust".to_string()]),
                keywords: Some(vec!["sql".to_string(), "query".to_string()]),
            }),
        )
        .expect("define rule 1");

    client
        .define_rule(
            "css-variables",
            "Use design tokens",
            Some("ui styling"),
            Some("ui"),
            Some(ContextTargets {
                files: Some(vec!["styles/**/*.css".to_string()]),
                languages: Some(vec!["css".to_string()]),
                keywords: Some(vec!["color".to_string()]),
            }),
        )
        .expect("define rule 2");

    // Match database context
    let matched = client
        .hints_for_context(
            &["src/db/repo.rs".to_string()],
            &["rust".to_string()],
            &["sql".to_string()],
        )
        .expect("context hints failed");

    assert_eq!(matched.len(), 1);
    assert_eq!(matched[0].key.id, "sql-param");

    // Format prompt
    let prompt = client.pack_prompt(1000).expect("pack prompt failed");
    assert!(prompt.contains("### Evidential Memory & Guiding Rules"));
    assert!(prompt.contains("sql-param"));
}

#[test]
fn test_rust_client_guard_and_gates() {
    let mut client = MedhaClient::in_memory().expect("failed to open");

    let key = client
        .define_rule("ci-check", "Must pass cargo check", None, None, None)
        .expect("define rule");

    let guard_hint = client
        .record_guard(medha::engine::GuardInput {
            key: key.clone(),
            kind: Some("cargo-check".to_string()),
            ok: true,
            at: 0,
            author: None,
            note: Some("Passes in CI".to_string()),
        })
        .expect("record guard failed");

    assert!(guard_hint.breakdown.guard_factor > 0.5);

    let gates = client
        .evaluate_gates(&key)
        .expect("evaluate gates failed")
        .expect("missing gates");

    assert!(!gates.is_empty());
    assert_eq!(gates[0].name, "trusted");
}

#[test]
fn test_rust_client_agent_session() {
    let mut client = MedhaClient::in_memory().expect("failed to open");

    let key = client
        .define_rule("format-rust", "Run cargo fmt", None, None, None)
        .expect("define rule");

    {
        let mut session = client.session("agent-rust-1").with_run_ref("task-101");
        let hint = session
            .accept(&key, Some("Formatted all files"))
            .expect("session accept failed");

        assert_eq!(hint.trials, 2.0);

        let prompt = session.pack_prompt(500).expect("pack prompt failed");
        assert!(prompt.contains("format-rust"));
    }

    let show = client.show(&key).expect("show failed");
    assert_eq!(show.hint.trials, 2.0);
}

#[test]
fn test_rust_client_sqlite_persistence() {
    let dir = tempdir().expect("tempdir failed");
    let db_path = dir.path().join("test_medha.db");

    {
        let mut client = MedhaClient::open(db_path.to_str().unwrap()).expect("open failed");
        client
            .define_rule("disk-rule", "Persisted rule", None, Some("db"), None)
            .expect("define rule");
    }

    {
        let client = MedhaClient::open(db_path.to_str().unwrap()).expect("reopen failed");
        let key = EntityKey::new("db", "rule", "disk-rule");
        let state = client
            .get(&key)
            .expect("get failed")
            .expect("missing state");
        assert_eq!(state.key.id, "disk-rule");
    }
}
