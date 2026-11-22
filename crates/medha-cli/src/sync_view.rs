//! `medha sync status|pull|push|reconcile` output in the TypeScript CLI's shapes: camelCase JSON
//! with a lowercase `state`, and the `renderSync*` text (`cli/src/render.ts`).

use medha::sync::traits::{PullResult, PushResult, ReconcileResult, SyncStatus};
use serde_json::{json, Value};

fn insert_opt(v: &mut Value, key: &str, value: &Option<String>) {
    if let Some(s) = value {
        v[key] = json!(s);
    }
}

pub fn status_json(s: &SyncStatus) -> Value {
    let mut v = json!({
        "state": format!("{:?}", s.state).to_lowercase(),
        "localCount": s.local_count,
    });
    if let Some(r) = s.remote_count {
        v["remoteCount"] = json!(r);
    }
    insert_opt(&mut v, "localHead", &s.local_head);
    insert_opt(&mut v, "remoteHead", &s.remote_head);
    insert_opt(&mut v, "ref", &s.ref_name);
    insert_opt(&mut v, "remoteUrl", &s.remote_url);
    insert_opt(&mut v, "message", &s.message);
    v
}

pub fn render_status(v: &Value) -> String {
    let mut lines = vec![
        format!(
            "Sync Status: {}",
            v["state"].as_str().unwrap_or("").to_uppercase()
        ),
        format!("  Local entities:  {}", v["localCount"]),
    ];
    if let Some(r) = v.get("remoteCount") {
        lines.push(format!("  Remote entities: {r}"));
    }
    if let Some(r) = v["ref"].as_str().filter(|r| !r.is_empty()) {
        lines.push(format!("  Target ref/file: {r}"));
    }
    if let Some(m) = v["message"].as_str().filter(|m| !m.is_empty()) {
        lines.push(format!("  Note:            {m}"));
    }
    lines.join("\n")
}

pub fn pull_json(r: &PullResult) -> Value {
    let mut v = json!({
        "ok": r.ok,
        "updated": r.updated,
        "pulledCount": r.pulled_count,
        "localTotal": r.local_total,
    });
    insert_opt(&mut v, "error", &r.error);
    v
}

pub fn render_pull(v: &Value) -> String {
    if v["ok"] != true {
        return format!(
            "Sync pull failed: {}",
            v["error"].as_str().unwrap_or("unknown error")
        );
    }
    [
        "Sync pull completed successfully.".to_string(),
        format!("  Pulled:       {}", v["pulledCount"]),
        format!("  Total local:  {}", v["localTotal"]),
        format!(
            "  Updated:      {}",
            if v["updated"] == true { "yes" } else { "no" }
        ),
    ]
    .join("\n")
}

pub fn push_json(r: &PushResult) -> Value {
    let mut v = json!({ "ok": r.ok, "pushedCount": r.pushed_count });
    insert_opt(&mut v, "commit", &r.commit);
    insert_opt(&mut v, "error", &r.error);
    v
}

pub fn render_push(v: &Value) -> String {
    if v["ok"] != true {
        return format!(
            "Sync push failed: {}",
            v["error"].as_str().unwrap_or("unknown error")
        );
    }
    let mut lines = vec![
        "Sync push completed successfully.".to_string(),
        format!("  Pushed entities: {}", v["pushedCount"]),
    ];
    if let Some(c) = v["commit"].as_str() {
        lines.push(format!("  Commit SHA:      {c}"));
    }
    lines.join("\n")
}

pub fn reconcile_json(r: &ReconcileResult) -> Value {
    let mut v = json!({
        "ok": r.ok,
        "pulledCount": r.pulled_count,
        "pushedCount": r.pushed_count,
        "totalCount": r.total_count,
    });
    insert_opt(&mut v, "commit", &r.commit);
    insert_opt(&mut v, "error", &r.error);
    v
}

pub fn render_reconcile(v: &Value) -> String {
    if v["ok"] != true {
        return format!(
            "Sync reconcile failed: {}",
            v["error"].as_str().unwrap_or("unknown error")
        );
    }
    [
        "Sync reconcile completed successfully.".to_string(),
        format!("  Pulled:       {}", v["pulledCount"]),
        format!("  Pushed:       {}", v["pushedCount"]),
        format!("  Total local:  {}", v["totalCount"]),
    ]
    .join("\n")
}
