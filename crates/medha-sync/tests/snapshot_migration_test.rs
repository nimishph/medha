use medha_sync::errors::SyncError;
use medha_sync::snapshot::{migrate_snapshot, serialize_snapshot, CURRENT_MEMORY_SCHEMA_VERSION};
use std::fs;
use std::path::PathBuf;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("medha")
        .join("src")
        .join("__tests__")
        .join("fixtures")
}

#[test]
fn test_migrate_v0_unversioned_fixture() {
    let path = fixtures_dir().join("v0-unversioned.json");
    let content = fs::read_to_string(&path).expect("read v0 fixture");
    let raw: serde_json::Value = serde_json::from_str(&content).expect("parse json");

    let snapshot = migrate_snapshot(raw).expect("migrate v0");
    assert_eq!(snapshot.schema_version, CURRENT_MEMORY_SCHEMA_VERSION);
    assert_eq!(snapshot.as_of, 1727000000000);
    assert!(snapshot.episodes.is_some());
    let episodes = snapshot.episodes.as_ref().unwrap();
    assert_eq!(episodes.len(), 2);
    assert_eq!(episodes[0].key.id, "rule-v0-1");
    assert_eq!(episodes[1].key.id, "rule-v0-2");

    // Serialization test
    let serialized = serialize_snapshot(&snapshot).expect("serialize");
    assert!(serialized.contains("schemaVersion"));
}

#[test]
fn test_migrate_v1_sage_fixture() {
    let path = fixtures_dir().join("v1-sage.json");
    let content = fs::read_to_string(&path).expect("read v1 sage fixture");
    let raw: serde_json::Value = serde_json::from_str(&content).expect("parse json");

    let snapshot = migrate_snapshot(raw).expect("migrate v1 sage");
    assert_eq!(snapshot.schema_version, 1);
    assert!(snapshot.registries.is_some());
    let reg = snapshot.registries.unwrap();
    assert!(reg.kinds.contains(&"prompt".to_string()));
    assert!(snapshot.meta.is_some());
    let meta = snapshot.meta.unwrap();
    assert_eq!(
        meta.get("sweep:lastRun").map(|s| s.as_str()),
        Some("1727100000000")
    );
}

#[test]
fn test_migrate_v1_current_fixture() {
    let path = fixtures_dir().join("v1-current.json");
    let content = fs::read_to_string(&path).expect("read v1 current fixture");
    let raw: serde_json::Value = serde_json::from_str(&content).expect("parse json");

    let snapshot = migrate_snapshot(raw).expect("migrate v1 current");
    assert_eq!(snapshot.schema_version, 1);
    let episodes = snapshot.episodes.expect("episodes present");
    assert_eq!(episodes.len(), 1);
    assert_eq!(episodes[0].key.id, "rule-medha-1");
}

#[test]
fn test_reject_future_version() {
    let path = fixtures_dir().join("v99-future.json");
    let content = fs::read_to_string(&path).expect("read v99 future fixture");
    let raw: serde_json::Value = serde_json::from_str(&content).expect("parse json");

    match migrate_snapshot(raw) {
        Err(SyncError::SchemaVersionMismatch { expected, found }) => {
            assert_eq!(expected, 1);
            assert_eq!(found, 99);
        }
        other => panic!("expected SchemaVersionMismatch, got: {:?}", other),
    }
}
