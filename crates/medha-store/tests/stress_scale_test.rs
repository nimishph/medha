use medha_core::types::{EntityKey, LifecycleStatus, SignalSpec};
use medha_store::{
    EpisodeInput, EpisodePayload, MemoryStore, OpenResult, SqliteStore, SqliteStoreOptions,
    StorePort,
};
use std::time::Instant;
use tempfile::NamedTempFile;

fn make_signal(id: &str, at: i64, success: bool) -> EpisodeInput {
    EpisodeInput {
        key: EntityKey::new("", "rule", id),
        at,
        author: None,
        payload: EpisodePayload::Signal {
            spec: SignalSpec {
                name: if success { "APPLY".to_string() } else { "REJECT_RULE".to_string() },
                value: if success { 1.0 } else { -1.0 },
                counts_as_trial: true,
                counts_as_success: success,
                description: Some("Stress Signal".to_string()),
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

/// Stress Test 1: 100,000 Distinct Entities Fold & Query Benchmark (medha-gmu.1)
#[test]
fn test_stress_100k_entities_fold_and_query() {
    println!("\n=== Starting 100,000 Entities Benchmark ===");
    let mut store = MemoryStore::new(None);
    store.open().expect("open store");

    let count = 100_000;
    println!("Generating and appending {} distinct entity episodes...", count);
    let start_append = Instant::now();

    for i in 0..count {
        let id = format!("rule-stress-{:06}", i);
        let success = i % 3 != 0;
        store.append(make_signal(&id, 1000 + i as i64, success)).unwrap();
    }

    let append_duration = start_append.elapsed();
    let eps_per_sec = (count as f64) / append_duration.as_secs_f64();
    println!(
        "✓ Ingested {} episodes in {:.2?} ({:.0} episodes/sec)",
        count, append_duration, eps_per_sec
    );

    // List/Query 100,000 entities
    let start_query = Instant::now();
    let entities = store.list().expect("list entities");
    let query_duration = start_query.elapsed();

    assert_eq!(entities.len(), count);
    println!(
        "✓ Listed {} projected entities in {:.2?}",
        entities.len(), query_duration
    );

    // Rebuild projection over 100k log
    let start_rebuild = Instant::now();
    store.rebuild().expect("rebuild store");
    let rebuild_duration = start_rebuild.elapsed();
    println!(
        "✓ Full rebuild of 100k log completed in {:.2?}",
        rebuild_duration
    );

    // Verify mathematical bounds on sample entities
    let sample = store.get(&EntityKey::new("", "rule", "rule-stress-000000")).unwrap().unwrap();
    assert_eq!(sample.evidence.n, 1.0);
    assert_eq!(sample.status, LifecycleStatus::Probation);
}

/// Stress Test 2: Deep 10,000-Episode Per-Entity Log Stress
#[test]
fn test_stress_deep_10k_episodes_single_entity() {
    println!("\n=== Starting 10,000 Deep Log Single Entity Stress Test ===");
    let mut store = MemoryStore::new(None);
    store.open().expect("open store");

    let total_signals = 10_000;
    let start = Instant::now();

    for i in 0..total_signals {
        // 90% success rate
        let success = i % 10 != 0;
        store.append(make_signal("deep-entity", 1000 + i as i64, success)).unwrap();
    }

    let duration = start.elapsed();
    println!(
        "✓ Appended {} deep signals to single entity in {:.2?} ({:.0} eps/sec)",
        total_signals, duration, (total_signals as f64) / duration.as_secs_f64()
    );

    let state_unguarded = store.get(&EntityKey::new("", "rule", "deep-entity")).unwrap().unwrap();
    assert_eq!(state_unguarded.evidence.n, 10_000.0);
    assert_eq!(state_unguarded.evidence.k, 9_000.0);
    // Invariant: Without guard, entity cannot exceed unguarded ceiling, so it remains Active
    assert_eq!(state_unguarded.status, LifecycleStatus::Active);

    // Now append a passing guard episode
    store.append(EpisodeInput {
        key: EntityKey::new("", "rule", "deep-entity"),
        at: 1000 + total_signals as i64,
        author: None,
        payload: EpisodePayload::Guard {
            ok: true,
            kind: Some("ast".to_string()),
            ensure: true,
            note: None,
        },
    }).unwrap();

    let state_guarded = store.get(&EntityKey::new("", "rule", "deep-entity")).unwrap().unwrap();
    // With guard passing, ceiling lifts to 1.0 and entity reaches Trusted!
    assert_eq!(state_guarded.status, LifecycleStatus::Trusted);
}

/// Stress Test 3: SQLite WAL 10,000 Batch Transactions & Integrity Replay
#[test]
fn test_stress_sqlite_wal_10k_batch_and_recovery() {
    println!("\n=== Starting SQLite WAL 10,000 Ingestion Stress Test ===");
    let tmp = NamedTempFile::new().expect("temp file");
    let path = tmp.path().to_str().expect("path string").to_string();

    let mut store = SqliteStore::new(SqliteStoreOptions {
        path: path.clone(),
        registries: None,
        resilient_replay: false,
    });

    assert_eq!(store.open().unwrap(), OpenResult::Ok);

    let count = 10_000;
    let start = Instant::now();

    for i in 0..count {
        let id = format!("sqlite-rule-{:04}", i % 500); // 500 distinct entities with 20 updates each
        let success = i % 4 != 0;
        store.append(make_signal(&id, 1000 + i as i64, success)).unwrap();
    }

    let duration = start.elapsed();
    println!(
        "✓ Ingested {} SQLite WAL episodes across 500 entities in {:.2?} ({:.0} eps/sec)",
        count, duration, (count as f64) / duration.as_secs_f64()
    );

    // Close SQLite database
    store.close().unwrap();
    assert!(!store.is_open());

    // Reopen and verify complete replay from disk
    let start_reopen = Instant::now();
    let mut reopened_store = SqliteStore::new(SqliteStoreOptions {
        path: path.clone(),
        registries: None,
        resilient_replay: false,
    });
    assert_eq!(reopened_store.open().unwrap(), OpenResult::Ok);
    let reopen_duration = start_reopen.elapsed();

    let entities = reopened_store.list().unwrap();
    assert_eq!(entities.len(), 500);

    let total_episodes = reopened_store.episodes(None, None).unwrap().len();
    assert_eq!(total_episodes, count);

    println!(
        "✓ SQLite store successfully reopened and validated in {:.2?} (500 entities, 10,000 episodes verified)",
        reopen_duration
    );
}
