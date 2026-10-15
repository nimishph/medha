use std::process::Command;
use tempfile::tempdir;

fn get_bin() -> std::path::PathBuf {
    let mut path = std::env::current_exe().expect("current exe");
    path.pop(); // Remove test exe name
    if path.ends_with("deps") {
        path.pop();
    }
    path.push("medha.exe");
    if !path.exists() {
        path.set_extension("");
    }
    path
}

#[test]
fn test_cli_primer_index_and_topic() {
    let bin = get_bin();

    // 1. Index
    let out = Command::new(&bin)
        .arg("primer")
        .output()
        .expect("exec primer");
    assert!(out.status.success());
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("# Medha Primer Index"));
    assert!(stdout.contains("Available Topics"));
    assert!(stdout.contains("signals"));
    assert!(stdout.contains("guards"));

    // 2. Topic compact
    let out2 = Command::new(&bin)
        .args(["primer", "guards", "--compact"])
        .output()
        .expect("exec primer guards");
    assert!(out2.status.success());
    let stdout2 = String::from_utf8_lossy(&out2.stdout);
    assert!(stdout2.contains("Automated Guards & The Unguarded Ceiling"));
    assert!(!stdout2.contains("Run 'medha primer' to view all topics."));

    // 3. Topic json
    let out3 = Command::new(&bin)
        .args(["primer", "signals", "--json"])
        .output()
        .expect("exec primer signals json");
    assert!(out3.status.success());
    let parsed: serde_json::Value = serde_json::from_slice(&out3.stdout).expect("parse json");
    assert_eq!(parsed["topic"], "signals");
    assert!(parsed["lineCount"].as_u64().unwrap() > 10);
}

#[test]
fn test_cli_params() {
    let bin = get_bin();

    let out = Command::new(&bin)
        .arg("params")
        .output()
        .expect("exec params");
    assert!(out.status.success());
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("canonical model parameters"));
    assert!(stdout.contains("WILSON_Z"));
    assert!(stdout.contains("TRUSTED_THRESHOLD"));
    assert!(stdout.contains("UNGUARDED_TRUST_CEILING"));

    let out_json = Command::new(&bin)
        .args(["params", "--json"])
        .output()
        .expect("exec params json");
    assert!(out_json.status.success());
    let parsed: serde_json::Value = serde_json::from_slice(&out_json.stdout).expect("parse json");
    assert!(parsed["params"].as_array().unwrap().len() >= 15);
}

#[test]
fn test_cli_issue_generation() {
    let bin = get_bin();

    let out = Command::new(&bin)
        .args(["issue", "Test bug report", "--json", "--open=false"])
        .output()
        .expect("exec issue");
    assert!(out.status.success());
    let parsed: serde_json::Value = serde_json::from_slice(&out.stdout).expect("parse json");
    assert_eq!(parsed["title"], "Test bug report");
    assert!(parsed["url"]
        .as_str()
        .unwrap()
        .contains("https://github.com/nimishph/medha/issues/new"));
    assert!(parsed["body"].as_str().unwrap().contains("Medha Version"));
}

#[test]
fn test_cli_lifecycle_and_pack() {
    let bin = get_bin();
    let dir = tempdir().expect("tempdir");
    let home = dir.path().to_str().expect("path str");

    // 1. Init
    let init_out = Command::new(&bin)
        .args(["--home", home, "init"])
        .output()
        .expect("init");
    assert!(init_out.status.success());

    // 2. Propose & Record
    let rec_out = Command::new(&bin)
        .args([
            "--home",
            home,
            "record",
            "--id",
            "perf-cache",
            "--signal",
            "APPLY",
            "--ensure",
        ])
        .output()
        .expect("record");
    assert!(rec_out.status.success());

    // 3. Pack Markdown
    let pack_out = Command::new(&bin)
        .args(["--home", home, "pack", "--budget", "500"])
        .output()
        .expect("pack");
    assert!(pack_out.status.success());
    let pack_str = String::from_utf8_lossy(&pack_out.stdout);
    assert!(pack_str.contains("Medha Evidential Context"));
    assert!(pack_str.contains("perf-cache"));

    // 4. Pack Compact
    let pack_compact = Command::new(&bin)
        .args([
            "--home", home, "pack", "--budget", "500", "--format", "compact",
        ])
        .output()
        .expect("pack compact");
    assert!(pack_compact.status.success());
    let compact_str = String::from_utf8_lossy(&pack_compact.stdout);
    assert!(compact_str.contains("medha: packed 1 entities"));
    assert!(compact_str.contains("perf-cache"));

    // 5. Pack JSON
    let pack_json = Command::new(&bin)
        .args([
            "--home", home, "pack", "--budget", "500", "--format", "json",
        ])
        .output()
        .expect("pack json");
    assert!(pack_json.status.success());
    let parsed: serde_json::Value = serde_json::from_slice(&pack_json.stdout).expect("parse json");
    assert_eq!(parsed["mandatoryCount"], 0);
    assert_eq!(parsed["meritCount"], 1);
    assert!(parsed["totalCost"].as_u64().unwrap() <= 500);
}

/// `show` and `explain-threshold` say when and why a status is latched (gh-20), with the same
/// episode and wording as the TypeScript CLI.
#[test]
fn test_cli_show_reports_the_retirement_latch() {
    let bin = get_bin();
    let dir = tempdir().expect("tempdir");
    let home = dir.path().to_str().expect("path str");
    let run = |args: &[&str]| {
        let mut all = vec!["--home", home];
        all.extend_from_slice(args);
        Command::new(&bin).args(&all).output().expect("medha")
    };
    assert!(run(&["init"]).status.success());
    let record = |signal: &str, ensure: bool| {
        let mut args = vec!["record", "--id", "q1", "--signal", signal];
        if ensure {
            args.push("--ensure");
        }
        assert!(run(&args).status.success());
    };
    record("REJECT_RULE", true);
    for _ in 0..4 {
        record("REJECT_RULE", false);
    }
    let quarantined = String::from_utf8_lossy(&run(&["show", "--id", "q1"]).stdout).to_string();
    assert!(!quarantined.contains("latched:"), "{quarantined}");
    for _ in 0..7 {
        record("APPLY", false);
    }
    let show = String::from_utf8_lossy(&run(&["show", "--id", "q1"]).stdout).to_string();
    assert!(
        show.contains("latched:  retired at #6 by evidence (2/7 successes)"),
        "{show}"
    );
    let explain = run(&["--json", "explain-threshold", "--id", "q1"]);
    let parsed: serde_json::Value = serde_json::from_slice(&explain.stdout).expect("json");
    assert_eq!(parsed["latch"]["seq"], 6);
    assert_eq!(parsed["latch"]["cause"], "evidence");
}

/// `reinstate` lifts a latch as one audited episode and refuses an entity that is not latched;
/// `retract --id` refuses another entity's episode and warns when it lifts a quarantine (gh-22).
#[test]
fn test_cli_reinstate_and_checked_retract() {
    let bin = get_bin();
    let dir = tempdir().expect("tempdir");
    let home = dir.path().to_str().expect("path str");
    let run = |args: &[&str]| {
        let mut all = vec!["--home", home];
        all.extend_from_slice(args);
        Command::new(&bin).args(&all).output().expect("medha")
    };
    assert!(run(&["init"]).status.success());
    assert!(
        run(&["record", "--id", "ok1", "--signal", "APPLY", "--ensure"])
            .status
            .success()
    );
    let refused = run(&["reinstate", "--id", "ok1", "--reason", "x"]);
    assert!(!refused.status.success());
    assert!(String::from_utf8_lossy(&refused.stderr).contains("is not latched"));

    assert!(
        run(&["override", "--id", "ok1", "--status", "retired", "--reason", "stale"])
            .status
            .success()
    );
    let reinstated = run(&["reinstate", "--id", "ok1", "--reason", "reviewed"]);
    assert!(reinstated.status.success());
    assert!(String::from_utf8_lossy(&reinstated.stdout)
        .contains("reinstated rule/ok1 (was retired since #1"));
    let show = String::from_utf8_lossy(&run(&["show", "--id", "ok1"]).stdout).to_string();
    assert!(!show.contains("latched:"), "{show}");

    // b: five failures, quarantined since the third (#4 in this log).
    assert!(
        run(&["record", "--id", "b", "--signal", "REJECT_RULE", "--ensure"])
            .status
            .success()
    );
    for _ in 0..4 {
        assert!(run(&["record", "--id", "b", "--signal", "REJECT_RULE"])
            .status
            .success());
    }
    let wrong = run(&["retract", "--seq", "0", "--reason", "x", "--id", "b"]);
    assert!(!wrong.status.success());
    assert!(String::from_utf8_lossy(&wrong.stderr).contains("belongs to rule/ok1"));

    for seq in ["7", "6"] {
        let out = run(&["retract", "--seq", seq, "--reason", "x", "--id", "b"]);
        assert!(out.status.success());
        assert!(!String::from_utf8_lossy(&out.stderr).contains("warning"));
    }
    let lifting = run(&["retract", "--seq", "5", "--reason", "x", "--id", "b"]);
    assert!(lifting.status.success());
    assert!(String::from_utf8_lossy(&lifting.stderr)
        .contains("took rule/b out of quarantined (now probation)"));
}

/// `list` and `pack` take `--ids` so a host can keep entities it no longer has out (gh-23).
#[test]
fn test_cli_ids_filter_on_list_and_pack() {
    let bin = get_bin();
    let dir = tempdir().expect("tempdir");
    let home = dir.path().to_str().expect("path str");
    let run = |args: &[&str]| {
        let mut all = vec!["--home", home];
        all.extend_from_slice(args);
        Command::new(&bin).args(&all).output().expect("medha")
    };
    assert!(run(&["init"]).status.success());
    for id in ["live-a", "live-b", "deleted-c"] {
        assert!(
            run(&["record", "--id", id, "--signal", "APPLY", "--ensure"])
                .status
                .success()
        );
    }
    let list = run(&["--json", "list", "--ids", "live-a, live-b"]);
    let parsed: serde_json::Value = serde_json::from_slice(&list.stdout).expect("list json");
    let mut ids: Vec<String> = parsed["page"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["key"]["id"].as_str().unwrap().to_string())
        .collect();
    ids.sort();
    assert_eq!(ids, ["live-a", "live-b"]);

    let pack = run(&["--json", "pack", "--budget", "2000", "--ids", "live-a"]);
    let parsed: serde_json::Value = serde_json::from_slice(&pack.stdout).expect("pack json");
    let selected: Vec<&str> = parsed["selected"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["key"]["id"].as_str().unwrap())
        .collect();
    assert_eq!(selected, ["live-a"]);

    assert!(!run(&["list", "--ids", " , "]).status.success());
}

/// A log that no longer continues from seq 0 opens corrupt, and the store reads only the prefix
/// before the break. Reads used to answer from that prefix ("0 entities", exit 0) and preflight
/// said OK (gh-18): evidence reads now fail, and preflight and status report the break and exit 1.
#[test]
fn test_cli_reads_fail_on_a_log_that_fails_integrity() {
    let bin = get_bin();
    let dir = tempdir().expect("tempdir");
    let home = dir.path().to_str().expect("path str");
    let run = |args: &[&str]| {
        let mut all = vec!["--home", home];
        all.extend_from_slice(args);
        Command::new(&bin).args(&all).output().expect("medha")
    };

    assert!(run(&["init"]).status.success());
    for _ in 0..3 {
        assert!(
            run(&["record", "--id", "r1", "--signal", "APPLY", "--ensure"])
                .status
                .success()
        );
    }
    let db = rusqlite::Connection::open(dir.path().join("store.sqlite")).expect("open db");
    db.execute("DELETE FROM episodes WHERE seq = 0", [])
        .expect("drop seq 0");
    drop(db);

    for read in [
        &["list"][..],
        &["show", "--id", "r1"],
        &["hints"],
        &["pack", "--budget", "500"],
    ] {
        let out = run(read);
        assert!(!out.status.success(), "{read:?} must fail");
        assert!(
            String::from_utf8_lossy(&out.stderr).contains("corrupt"),
            "{read:?} must say why"
        );
    }

    let preflight = run(&["preflight"]);
    assert_eq!(preflight.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&preflight.stdout).contains("FAILED"));

    let status = run(&["status"]);
    assert_eq!(status.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&status.stdout).contains("by status:  unavailable"));
}

/// `guard --ok` without `--guard` on an entity with no guard used to print "guard passed" while the
/// report was stored against kind `none` and changed nothing (gh-17). It is refused instead; once
/// the entity has a guard, omitting `--guard` reuses it.
#[test]
fn test_cli_guard_without_kind_is_refused_until_the_entity_has_a_guard() {
    let bin = get_bin();
    let dir = tempdir().expect("tempdir");
    let home = dir.path().to_str().expect("path str");
    let run = |args: &[&str]| {
        let mut all = vec!["--home", home];
        all.extend_from_slice(args);
        Command::new(&bin).args(&all).output().expect("medha")
    };

    assert!(run(&["init"]).status.success());
    assert!(
        run(&["record", "--id", "g1", "--signal", "APPLY", "--ensure"])
            .status
            .success()
    );

    let bare = run(&["guard", "--id", "g1", "--ok"]);
    assert!(!bare.status.success());
    assert!(String::from_utf8_lossy(&bare.stderr).contains("--guard"));
    assert!(!String::from_utf8_lossy(&bare.stdout).contains("guard passed"));

    assert!(run(&["guard", "--id", "g1", "--ok", "--guard", "harness"])
        .status
        .success());
    let reused = run(&["guard", "--id", "g1", "--fail"]);
    assert!(reused.status.success());
    let show = run(&["--json", "show", "--id", "g1"]);
    let parsed: serde_json::Value = serde_json::from_slice(&show.stdout).expect("show json");
    assert_eq!(parsed["hint"]["status"], "quarantined");
}

/// A store's `config.json` decides which signals and kinds exist, for this engine as for the
/// TypeScript one that may share the store. An episode with a signal the registry lacks makes the
/// TypeScript engine read the whole store as corrupt, so it must be refused, not written.
#[test]
fn test_cli_refuses_signals_and_kinds_the_store_does_not_register() {
    let bin = get_bin();
    let dir = tempdir().expect("tempdir");
    let home = dir.path().to_str().expect("path str");

    // The registries the TypeScript `medha init` writes: the four canonical signals, no FLAKY.
    let config = serde_json::json!({
        "layoutVersion": 1,
        "backend": "sqlite",
        "path": "store.sqlite",
        "registries": {
            "kinds": ["rule", "recipe", "tool"],
            "signalSpecs": [
                { "name": "APPLY", "value": 1, "countsAsTrial": true, "countsAsSuccess": true },
                { "name": "SKIP", "value": 0, "countsAsTrial": false, "countsAsSuccess": false },
                { "name": "REJECT_CONTEXT", "value": -0.2, "countsAsTrial": false, "countsAsSuccess": false },
                { "name": "REJECT_RULE", "value": -1, "countsAsTrial": true, "countsAsSuccess": false }
            ],
            "anchorKinds": ["git", "week"]
        }
    });
    std::fs::write(
        dir.path().join("config.json"),
        serde_json::to_string_pretty(&config).unwrap(),
    )
    .expect("write config");

    let record = |args: &[&str]| {
        let mut all = vec!["--home", home, "record", "--id", "r", "--ensure"];
        all.extend_from_slice(args);
        Command::new(&bin).args(&all).output().expect("record")
    };

    assert!(record(&["--signal", "APPLY"]).status.success());

    let flaky = record(&["--signal", "FLAKY"]);
    assert!(!flaky.status.success(), "FLAKY is not registered here");
    assert!(String::from_utf8_lossy(&flaky.stderr).contains("Unknown signal 'FLAKY'"));

    let lint = record(&["--signal", "APPLY", "--kind", "lint"]);
    assert!(!lint.status.success(), "kind 'lint' is not registered here");
    assert!(String::from_utf8_lossy(&lint.stderr).contains("Unknown kind 'lint'"));
}
