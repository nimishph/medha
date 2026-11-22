//! CLI regressions from the 0.8.0-alpha.1 field test.

use std::path::Path;
use std::process::{Command, Output};
use tempfile::tempdir;

fn medha(cwd: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_medha"))
        .current_dir(cwd)
        .args(args)
        .output()
        .expect("exec medha")
}

fn episode_count(cwd: &Path) -> u64 {
    let out = medha(cwd, &["--json", "status"]);
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).expect("json");
    v["preflight"]["episodeCount"].as_u64().expect("count")
}

#[test]
fn init_writes_gitignore_and_reports_agent_files() {
    let dir = tempdir().expect("tmp");
    std::fs::write(dir.path().join("CLAUDE.md"), "# Project\n").expect("write");
    let out = medha(dir.path(), &["init"]);
    assert!(out.status.success());
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        stdout.contains("CLAUDE.md"),
        "init names the file it edited: {stdout}"
    );

    let gi = std::fs::read_to_string(dir.path().join(".medha/.gitignore")).expect("gitignore");
    assert!(gi.lines().any(|l| l == "store.sqlite"));
    assert!(gi.lines().any(|l| l == "store.sqlite-wal"));
    assert!(!gi.contains("\nconfig.json"));

    // Re-running reports nothing new to edit.
    let again = medha(dir.path(), &["init"]);
    assert!(!String::from_utf8_lossy(&again.stdout).contains("updated:"));
}

#[test]
fn record_on_unknown_entity_without_ensure_is_refused() {
    let dir = tempdir().expect("tmp");
    assert!(medha(dir.path(), &["init", "--no-agents-file"])
        .status
        .success());
    let before = episode_count(dir.path());

    let out = medha(
        dir.path(),
        &["record", "--id", "ghost", "--signal", "APPLY"],
    );
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("unknown"));
    assert_eq!(
        episode_count(dir.path()),
        before,
        "no orphan episode written"
    );

    let ok = medha(
        dir.path(),
        &["record", "--id", "ghost", "--signal", "APPLY", "--ensure"],
    );
    assert!(ok.status.success());
    assert_eq!(episode_count(dir.path()), before + 1);
}

#[test]
fn compact_keeps_recent_episodes_by_default() {
    let dir = tempdir().expect("tmp");
    assert!(medha(dir.path(), &["init", "--no-agents-file"])
        .status
        .success());
    for _ in 0..3 {
        let out = medha(
            dir.path(),
            &["record", "--id", "r", "--signal", "APPLY", "--ensure"],
        );
        assert!(out.status.success());
    }
    for args in [&["compact"][..], &["maintain", "compact"][..]] {
        let out = medha(dir.path(), args);
        assert!(out.status.success());
        assert_eq!(
            episode_count(dir.path()),
            3,
            "{args:?} folded minutes-old history"
        );
    }
    let bad = medha(dir.path(), &["compact", "--older-than", "0"]);
    assert!(!bad.status.success());
}
