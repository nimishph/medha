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
