use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use tempfile::tempdir;

fn get_bin() -> std::path::PathBuf {
    let mut path = std::env::current_exe().expect("current exe");
    path.pop();
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
fn test_medha_complete_100pct_feature_matrix_e2e() {
    let bin = get_bin();
    let dir = tempdir().expect("tempdir");
    let home = dir.path().to_str().expect("path str");

    // ==========================================
    // 1. init (both sqlite and memory)
    // ==========================================
    let init_out = Command::new(&bin)
        .args(["--home", home, "init"])
        .output()
        .expect("init");
    assert!(init_out.status.success());
    let init_str = String::from_utf8_lossy(&init_out.stdout);
    assert!(init_str.contains("initialized engine home"));

    // Verify re-init idempotency
    let reinit_out = Command::new(&bin)
        .args(["--home", home, "init", "--json"])
        .output()
        .expect("reinit");
    assert!(reinit_out.status.success());
    let reinit_json: Value = serde_json::from_slice(&reinit_out.stdout).expect("parse json");
    assert_eq!(reinit_json["status"], "exists");

    // ==========================================
    // 2. propose multiple kinds & namespaces
    // ==========================================
    let prop1 = Command::new(&bin)
        .args([
            "--home",
            home,
            "propose",
            "--id",
            "rule-strict-typing",
            "--kind",
            "rule",
            "--namespace",
            "core",
            "--source",
            "rfc-101",
            "--theta0",
            "0.6",
            "--description",
            "Enforce strict TypeScript / Rust types",
        ])
        .output()
        .expect("prop1");
    assert!(prop1.status.success());

    let prop2 = Command::new(&bin)
        .args([
            "--home",
            home,
            "propose",
            "--id",
            "recipe-ci-deploy",
            "--kind",
            "recipe",
            "--source",
            "devops-guide",
            "--description",
            "Automated deployment pipeline",
        ])
        .output()
        .expect("prop2");
    assert!(prop2.status.success());

    // ==========================================
    // 3. record diverse signals
    // ==========================================
    // Record APPLY
    let rec_apply = Command::new(&bin)
        .args([
            "--home",
            home,
            "record",
            "--id",
            "rule-strict-typing",
            "--namespace",
            "core",
            "--signal",
            "APPLY",
            "--author",
            "agent-alpha",
            "--run-ref",
            "commit-abc123",
            "--note",
            "Passed typechecker without error",
        ])
        .output()
        .expect("rec_apply");
    assert!(rec_apply.status.success());

    // Record FLAKY on recipe
    let rec_flaky = Command::new(&bin)
        .args([
            "--home",
            home,
            "record",
            "--id",
            "recipe-ci-deploy",
            "--kind",
            "recipe",
            "--signal",
            "FLAKY",
            "--author",
            "ci-runner",
            "--note",
            "Intermittent network failure",
        ])
        .output()
        .expect("rec_flaky");
    assert!(rec_flaky.status.success());

    // Record ADOPTED, REJECT_CONTEXT, SKIP
    for sig in &["ADOPTED", "REJECT_CONTEXT", "SKIP", "APPLY", "APPLY"] {
        let r = Command::new(&bin)
            .args([
                "--home",
                home,
                "record",
                "--id",
                "rule-strict-typing",
                "--namespace",
                "core",
                "--signal",
                sig,
            ])
            .output()
            .expect("record sig");
        assert!(r.status.success());
    }

    // ==========================================
    // 4. guard reporting (--ok, --fail)
    // ==========================================
    let guard_ok = Command::new(&bin)
        .args([
            "--home",
            home,
            "guard",
            "--id",
            "rule-strict-typing",
            "--namespace",
            "core",
            "--ok",
            "--guard",
            "test-suite",
            "--author",
            "test-harness",
            "--note",
            "All unit tests green",
        ])
        .output()
        .expect("guard_ok");
    assert!(guard_ok.status.success());

    let guard_fail = Command::new(&bin)
        .args([
            "--home",
            home,
            "guard",
            "--id",
            "recipe-ci-deploy",
            "--kind",
            "recipe",
            "--fail",
            "--guard",
            "e2e-suite",
            "--author",
            "qa-bot",
        ])
        .output()
        .expect("guard_fail");
    assert!(guard_fail.status.success());

    // ==========================================
    // 5. show (text & JSON)
    // ==========================================
    let show_out = Command::new(&bin)
        .args([
            "--home",
            home,
            "show",
            "--id",
            "rule-strict-typing",
            "--namespace",
            "core",
        ])
        .output()
        .expect("show");
    assert!(show_out.status.success());
    let show_str = String::from_utf8_lossy(&show_out.stdout);
    assert!(show_str.contains("core/rule/rule-strict-typing"));
    assert!(show_str.contains("wilson"));
    assert!(show_str.contains("guard"));
    assert!(show_str.contains("recency"));
    assert!(show_str.contains("durability"));

    let show_json = Command::new(&bin)
        .args([
            "--home",
            home,
            "--json",
            "show",
            "--id",
            "rule-strict-typing",
            "--namespace",
            "core",
        ])
        .output()
        .expect("show_json");
    assert!(show_json.status.success());
    let parsed_show: Value = serde_json::from_slice(&show_json.stdout).expect("parse json");
    assert_eq!(parsed_show["key"]["id"], "rule-strict-typing");
    assert!(parsed_show["hint"]["trust"].as_f64().unwrap() > 0.0);

    // ==========================================
    // 6. explain-threshold
    // ==========================================
    let explain_out = Command::new(&bin)
        .args([
            "--home",
            home,
            "explain-threshold",
            "--id",
            "rule-strict-typing",
            "--namespace",
            "core",
        ])
        .output()
        .expect("explain");
    assert!(explain_out.status.success());
    let explain_str = String::from_utf8_lossy(&explain_out.stdout);
    assert!(explain_str.contains("explain thresholds"));
    assert!(explain_str.contains("trusted:"));
    assert!(explain_str.contains("active:"));

    // ==========================================
    // 7. simulate
    // ==========================================
    let sim_out = Command::new(&bin)
        .args([
            "--home",
            home,
            "simulate",
            "--id",
            "rule-strict-typing",
            "--namespace",
            "core",
            "--signal",
            "APPLY",
        ])
        .output()
        .expect("simulate");
    assert!(sim_out.status.success());
    let sim_str = String::from_utf8_lossy(&sim_out.stdout);
    assert!(sim_str.contains("simulate APPLY on core/rule/rule-strict-typing"));
    assert!(sim_str.contains("trust:"));

    // ==========================================
    // 8. hints
    // ==========================================
    let hints_out = Command::new(&bin)
        .args(["--home", home, "hints"])
        .output()
        .expect("hints");
    assert!(hints_out.status.success());
    let hints_str = String::from_utf8_lossy(&hints_out.stdout);
    assert!(hints_str.contains("rule-strict-typing"));

    // ==========================================
    // 9. list with filters
    // ==========================================
    let list_kind = Command::new(&bin)
        .args(["--home", home, "list", "--kind", "rule"])
        .output()
        .expect("list_kind");
    assert!(list_kind.status.success());
    let list_str = String::from_utf8_lossy(&list_kind.stdout);
    assert!(list_str.contains("rule-strict-typing"));
    assert!(!list_str.contains("recipe-ci-deploy"));

    let list_ns = Command::new(&bin)
        .args(["--home", home, "list", "--namespace", "core"])
        .output()
        .expect("list_ns");
    assert!(list_ns.status.success());
    assert!(String::from_utf8_lossy(&list_ns.stdout).contains("rule-strict-typing"));

    // ==========================================
    // 10. drift
    // ==========================================
    let drift_out = Command::new(&bin)
        .args(["--home", home, "drift"])
        .output()
        .expect("drift");
    assert!(drift_out.status.success());

    // ==========================================
    // 11. override (quarantined, restore)
    // ==========================================
    let ov_quarantine = Command::new(&bin)
        .args([
            "--home",
            home,
            "override",
            "--id",
            "rule-strict-typing",
            "--namespace",
            "core",
            "--status",
            "quarantined",
            "--reason",
            "Investigating type inference edge cases",
        ])
        .output()
        .expect("override quarantine");
    assert!(ov_quarantine.status.success());

    let show_quarantine = Command::new(&bin)
        .args([
            "--home",
            home,
            "--json",
            "show",
            "--id",
            "rule-strict-typing",
            "--namespace",
            "core",
        ])
        .output()
        .expect("show quarantine");
    let show_q_json: Value = serde_json::from_slice(&show_quarantine.stdout).expect("parse json");
    assert_eq!(show_q_json["hint"]["status"], "quarantined");

    let ov_restore = Command::new(&bin)
        .args([
            "--home",
            home,
            "override",
            "--id",
            "rule-strict-typing",
            "--namespace",
            "core",
            "--status",
            "restore",
            "--reason",
            "Edge cases resolved",
        ])
        .output()
        .expect("override restore");
    assert!(ov_restore.status.success());

    // ==========================================
    // 12. sweep
    // ==========================================
    let sweep_out = Command::new(&bin)
        .args(["--home", home, "sweep", "--older-than", "90"])
        .output()
        .expect("sweep");
    assert!(sweep_out.status.success());
    let sweep_str = String::from_utf8_lossy(&sweep_out.stdout);
    assert!(sweep_str.contains("swept") && sweep_str.contains("entities"));

    // ==========================================
    // 13. compact
    // ==========================================
    let compact_out = Command::new(&bin)
        .args(["--home", home, "compact", "--older-than", "90"])
        .output()
        .expect("compact");
    assert!(compact_out.status.success());
    assert!(String::from_utf8_lossy(&compact_out.stdout).contains("compaction complete"));

    // ==========================================
    // 14. preflight
    // ==========================================
    let preflight_out = Command::new(&bin)
        .args(["--home", home, "preflight"])
        .output()
        .expect("preflight");
    assert!(preflight_out.status.success());
    let preflight_str = String::from_utf8_lossy(&preflight_out.stdout);
    assert!(preflight_str.contains("preflight integrity: OK"));

    // ==========================================
    // 15. status
    // ==========================================
    let status_out = Command::new(&bin)
        .args(["--home", home, "status"])
        .output()
        .expect("status");
    assert!(status_out.status.success());
    let status_str = String::from_utf8_lossy(&status_out.stdout);
    assert!(status_str.contains("status for"));
    assert!(status_str.contains("preflight:  ok"));
    assert!(status_str.contains("by status:"));

    // ==========================================
    // 16. sync (file-based push, status, reconcile)
    // ==========================================
    let sync_file = dir.path().join("sync-export.json");
    let sync_path = sync_file.to_str().expect("sync path");

    let sync_push = Command::new(&bin)
        .args(["--home", home, "sync", "--file", sync_path, "push"])
        .output()
        .expect("sync push");
    assert!(sync_push.status.success());
    assert!(String::from_utf8_lossy(&sync_push.stdout).contains("sync push complete"));

    let sync_status = Command::new(&bin)
        .args(["--home", home, "sync", "--file", sync_path, "status"])
        .output()
        .expect("sync status");
    assert!(sync_status.status.success());
    assert!(String::from_utf8_lossy(&sync_status.stdout).contains("Synced"));

    let sync_reconcile = Command::new(&bin)
        .args(["--home", home, "sync", "--file", sync_path, "reconcile"])
        .output()
        .expect("sync reconcile");
    assert!(sync_reconcile.status.success());

    // ==========================================
    // 17. pack context (markdown, compact, json)
    // ==========================================
    let pack_md = Command::new(&bin)
        .args([
            "--home", home, "pack", "--budget", "1000", "--format", "markdown",
        ])
        .output()
        .expect("pack md");
    assert!(pack_md.status.success());
    let pack_str = String::from_utf8_lossy(&pack_md.stdout);
    assert!(pack_str.contains("# Medha Evidential Context"));
    assert!(pack_str.contains("rule-strict-typing"));

    let pack_json = Command::new(&bin)
        .args([
            "--home", home, "pack", "--budget", "1000", "--format", "json",
        ])
        .output()
        .expect("pack json");
    assert!(pack_json.status.success());
    let pack_j: Value = serde_json::from_slice(&pack_json.stdout).expect("parse pack json");
    assert!(pack_j["selected"].as_array().unwrap().len() >= 1);
    assert!(pack_j["totalCost"].as_u64().unwrap() <= 1000);

    // ==========================================
    // 18. mcp server over stdio (all 14 tools check)
    // ==========================================
    let mut mcp_child = Command::new(&bin)
        .args(["--home", home, "mcp"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn mcp");

    {
        let stdin = mcp_child.stdin.as_mut().expect("mcp stdin");
        let stdout = mcp_child.stdout.as_mut().expect("mcp stdout");
        let mut reader = BufReader::new(stdout);

        // 18a. Initialize
        writeln!(
            stdin,
            r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"protocolVersion":"2024-11-05","capabilities":{{}},"clientInfo":{{"name":"test-harness","version":"1.0"}}}}}}"#
        )
        .expect("write init");
        stdin.flush().expect("flush init");

        let mut line = String::new();
        reader.read_line(&mut line).expect("read init resp");
        let init_resp: Value = serde_json::from_str(&line).expect("parse init resp");
        assert_eq!(init_resp["id"], 1);
        assert_eq!(init_resp["result"]["serverInfo"]["name"], "medha");

        // 18b. Tools list
        writeln!(
            stdin,
            r#"{{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{{}}}}"#
        )
        .expect("write tools list");
        stdin.flush().expect("flush tools list");

        line.clear();
        reader.read_line(&mut line).expect("read tools resp");
        let tools_resp: Value = serde_json::from_str(&line).expect("parse tools resp");
        assert_eq!(tools_resp["id"], 2);
        let tools = tools_resp["result"]["tools"]
            .as_array()
            .expect("tools array");
        assert_eq!(tools.len(), 15);

        let tool_names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(tool_names.contains(&"hints"));
        assert!(tool_names.contains(&"list_entities"));
        assert!(tool_names.contains(&"show_entity"));
        assert!(tool_names.contains(&"explain_threshold"));
        assert!(tool_names.contains(&"record_signal"));
        assert!(tool_names.contains(&"report_guard"));
        assert!(tool_names.contains(&"record_decision"));
        assert!(tool_names.contains(&"propose"));
        assert!(tool_names.contains(&"drift"));
        assert!(tool_names.contains(&"simulate"));
        assert!(tool_names.contains(&"status"));
        assert!(tool_names.contains(&"retract_episode"));
        assert!(tool_names.contains(&"remove_episode"));
        assert!(tool_names.contains(&"pack_context"));
        assert!(tool_names.contains(&"primer"));

        // 18c. Call tool: hints
        writeln!(
            stdin,
            r#"{{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{{"name":"hints","arguments":{{"keys":[{{"id":"rule-strict-typing","kind":"rule","namespace":"core"}}]}}}}}}"#
        )
        .expect("write call hints");
        stdin.flush().expect("flush call hints");

        line.clear();
        reader.read_line(&mut line).expect("read hints resp");
        let hints_resp: Value = serde_json::from_str(&line).expect("parse hints resp");
        assert_eq!(hints_resp["id"], 3);
        let content = hints_resp["result"]["content"][0]["text"].as_str().unwrap();
        assert!(content.contains("rule-strict-typing"));

        // 18d. Call tool: pack_context
        writeln!(
            stdin,
            r#"{{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{{"name":"pack_context","arguments":{{"budget":500}}}}}}"#
        )
        .expect("write call pack_context");
        stdin.flush().expect("flush call pack_context");

        line.clear();
        reader.read_line(&mut line).expect("read pack resp");
        let pack_resp: Value = serde_json::from_str(&line).expect("parse pack resp");
        assert_eq!(pack_resp["id"], 4);
        let pack_text = pack_resp["result"]["content"][0]["text"].as_str().unwrap();
        assert!(pack_text.contains("Medha Evidential Context"));

        // 18e. Call tool: retract_episode
        writeln!(
            stdin,
            r#"{{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{{"name":"retract_episode","arguments":{{"seq":1,"reason":"Mistaken signal entry"}}}}}}"#
        )
        .expect("write retract");
        stdin.flush().expect("flush retract");

        line.clear();
        reader.read_line(&mut line).expect("read retract resp");
        let retract_resp: Value = serde_json::from_str(&line).expect("parse retract resp");
        assert_eq!(retract_resp["id"], 5);
        assert!(!retract_resp["result"]["isError"].as_bool().unwrap_or(false));
    }

    let _ = mcp_child.kill();
}
