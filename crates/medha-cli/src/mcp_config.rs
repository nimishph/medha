//! `medha mcp config`: registry-driven MCP client snippets and writes, a port of the TypeScript
//! `cli/src/integrations/` (registry, render, write, mcp-config) over the same bundled
//! `clients.json`. Needs no engine home.
//!
//! Each client's document template is resolved against a launcher's argv (`$argv`, `$argv[i]`,
//! `$argv[i:]`, `$argv[i:j]`, `$env`, `$serverName`, `${version}`), nested under the scope's
//! container, and either printed or merged into the client's config file without touching the
//! other servers there.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::args::McpConfigArgs;
use crate::failure::Failure;

const BUNDLED_CLIENTS_JSON: &str = include_str!("../../../cli/src/integrations/clients.json");
const VERSION: &str = env!("CARGO_PKG_VERSION");
const VERSION_PLACEHOLDER: &str = "${version}";

type Res<T> = Result<T, Box<dyn std::error::Error>>;

fn registry_error(problem: impl Into<String>, hint: impl Into<String>) -> Failure {
    let problem = problem.into();
    Failure::cli(
        "McpRegistryError",
        "CLI_MCP_REGISTRY_INVALID",
        format!("mcp client registry: {problem}"),
    )
    .with_context(json!({ "problem": problem }))
    .with_hint(hint)
}

fn registry() -> Res<Value> {
    Ok(serde_json::from_str(BUNDLED_CLIENTS_JSON)?)
}

fn clients(reg: &Value) -> Vec<Value> {
    reg["clients"].as_array().cloned().unwrap_or_default()
}

fn client_by_id(reg: &Value, id: &str) -> Result<Value, Failure> {
    let all = clients(reg);
    all.iter().find(|c| c["id"] == id).cloned().ok_or_else(|| {
        let known: Vec<&str> = all.iter().filter_map(|c| c["id"].as_str()).collect();
        Failure::cli(
            "McpClientNotFoundError",
            "CLI_MCP_CLIENT_UNKNOWN",
            format!("no MCP client named '{id}'"),
        )
        .with_context(json!({ "name": id, "known": known }))
        .with_hint(format!("known clients: {}", known.join(", ")))
    })
}

fn launcher_by_id(reg: &Value, id: Option<&str>) -> Result<(String, Value), Failure> {
    let id = id.unwrap_or("path");
    match reg["launchers"].get(id) {
        Some(l) => Ok((id.to_string(), l.clone())),
        None => {
            let known: Vec<String> = reg["launchers"]
                .as_object()
                .map(|m| m.keys().cloned().collect())
                .unwrap_or_default();
            Err(registry_error(
                format!("no launcher named '{id}'"),
                format!("known launchers: {}", known.join(", ")),
            ))
        }
    }
}

fn scope_by_id(client: &Value, id: Option<&str>) -> Result<Value, Failure> {
    let scopes = client["scopes"].as_array().cloned().unwrap_or_default();
    let cid = client["id"].as_str().unwrap_or("");
    let names = || {
        scopes
            .iter()
            .filter_map(|s| s["id"].as_str())
            .collect::<Vec<_>>()
            .join(", ")
    };
    match id {
        None => scopes
            .iter()
            .find(|s| s["default"] == true)
            .cloned()
            .or_else(|| (scopes.len() == 1).then(|| scopes[0].clone()))
            .ok_or_else(|| {
                registry_error(
                    format!("client '{cid}' has no default scope"),
                    format!("pass --scope: {}", names()),
                )
            }),
        Some(id) => scopes
            .iter()
            .find(|s| s["id"] == id)
            .cloned()
            .ok_or_else(|| {
                registry_error(
                    format!("client '{cid}' has no scope '{id}'"),
                    format!("known scopes: {}", names()),
                )
            }),
    }
}

fn container_for(client: &Value, scope: &Value) -> Vec<String> {
    let c = if scope["container"].is_array() {
        &scope["container"]
    } else {
        &client["document"]["container"]
    };
    c.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// A config path as the TypeScript `displayPath` prints it: per-platform variants spelled out.
fn display_path(spec: &Value) -> String {
    if let Some(s) = spec.as_str() {
        return s.to_string();
    }
    let mut parts = Vec::new();
    if let Some(d) = spec["darwin"].as_str() {
        parts.push(format!("{d} (macOS)"));
    }
    if let Some(w) = spec["windows"].as_str() {
        parts.push(format!("{w} (Windows)"));
    }
    parts.push(format!(
        "{} (Linux/other)",
        spec["default"].as_str().unwrap_or("")
    ));
    parts.join(" · ")
}

fn pick_path(spec: &Value) -> String {
    if let Some(s) = spec.as_str() {
        return s.to_string();
    }
    let key = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "default"
    };
    spec[key]
        .as_str()
        .or_else(|| spec["default"].as_str())
        .unwrap_or("")
        .to_string()
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// The absolute file a scope's path names: `~` expanded, `%VAR%` / `${VAR}` substituted, relative
/// paths against the project directory (TypeScript `resolvePath`).
fn resolve_path(spec: &Value, cwd: &Path) -> Result<PathBuf, Failure> {
    let mut path = pick_path(spec);
    if path == "~" || path.starts_with("~/") || path.starts_with("~\\") {
        let home = home_dir().ok_or_else(|| {
            registry_error(
                format!("cannot resolve config path '{path}': the home directory is not set"),
                "set HOME (or USERPROFILE on Windows)",
            )
        })?;
        path = format!("{}{}", home.display(), &path[1..]);
    }
    let mut out = String::new();
    let mut rest = path.as_str();
    while !rest.is_empty() {
        let (start, open, close) = match (rest.find('%'), rest.find("${")) {
            (Some(p), Some(b)) if b < p => (b, 2, '}'),
            (Some(p), _) => (p, 1, '%'),
            (None, Some(b)) => (b, 2, '}'),
            (None, None) => break,
        };
        let after = &rest[start + open..];
        let Some(end) = after.find(close) else {
            break;
        };
        let name = &after[..end];
        let valid = !name.is_empty()
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            && !name.starts_with(|c: char| c.is_ascii_digit());
        out.push_str(&rest[..start]);
        if valid {
            let value = std::env::var(name)
                .ok()
                .filter(|v| !v.is_empty())
                .ok_or_else(|| {
                    registry_error(
                        format!("cannot resolve config path '{path}': {name} is not set"),
                        format!("set {name}, or edit clients.json to use a different path"),
                    )
                })?;
            out.push_str(&value);
        } else {
            out.push_str(&rest[start..start + open + end + 1]);
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    let p = PathBuf::from(out);
    Ok(if p.is_absolute() { p } else { cwd.join(p) })
}

struct Ctx<'a> {
    argv: Vec<String>,
    env: Map<String, Value>,
    server_name: &'a str,
    where_: &'a str,
}

fn is_empty(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::String(s) => s.is_empty(),
        Value::Array(a) => a.is_empty(),
        Value::Object(o) => o.is_empty(),
        _ => false,
    }
}

fn out_of_range(r: &str, ctx: &Ctx) -> Failure {
    registry_error(
        format!(
            "client '{}': {r} is out of range (argv has {} elements)",
            ctx.where_,
            ctx.argv.len()
        ),
        "fix the reference, or the launcher argv it reads from",
    )
}

fn resolve_ref(r: &str, ctx: &Ctx) -> Result<Value, Failure> {
    match r {
        "$serverName" => return Ok(json!(ctx.server_name)),
        "$env" => return Ok(Value::Object(ctx.env.clone())),
        "$argv" => return Ok(json!(ctx.argv)),
        _ => {}
    }
    if let Some(inner) = r.strip_prefix("$argv[").and_then(|s| s.strip_suffix(']')) {
        let parse = |s: &str| s.parse::<usize>().ok();
        match inner.split_once(':') {
            None => {
                let i = parse(inner).ok_or_else(|| out_of_range(r, ctx))?;
                return ctx
                    .argv
                    .get(i)
                    .map(|a| json!(a))
                    .ok_or_else(|| out_of_range(r, ctx));
            }
            Some((a, b)) => {
                let start = parse(a).ok_or_else(|| out_of_range(r, ctx))?;
                if b.is_empty() {
                    if start > ctx.argv.len() {
                        return Err(out_of_range(r, ctx));
                    }
                    return Ok(json!(ctx.argv[start..]));
                }
                let end = parse(b).ok_or_else(|| out_of_range(r, ctx))?;
                if start > end || end > ctx.argv.len() {
                    return Err(out_of_range(r, ctx));
                }
                return Ok(json!(ctx.argv[start..end]));
            }
        }
    }
    Err(registry_error(
        format!("client '{}': unknown template reference '{r}'", ctx.where_),
        "references are $argv, $argv[i], $argv[i:], $argv[i:j], $env, $serverName",
    ))
}

fn resolve_value(v: &Value, ctx: &Ctx) -> Result<Value, Failure> {
    Ok(match v {
        Value::String(s) => {
            let s = s.replace(VERSION_PLACEHOLDER, VERSION);
            if s.starts_with('$') {
                resolve_ref(&s, ctx)?
            } else {
                json!(s)
            }
        }
        Value::Array(a) => {
            let mut out = Vec::new();
            for item in a {
                let r = resolve_value(item, ctx)?;
                if !is_empty(&r) {
                    out.push(r);
                }
            }
            Value::Array(out)
        }
        Value::Object(o) => resolve_object(o, ctx)?,
        other => other.clone(),
    })
}

fn resolve_object(o: &Map<String, Value>, ctx: &Ctx) -> Result<Value, Failure> {
    let mut out = Map::new();
    for (k, v) in o {
        let r = resolve_value(v, ctx)?;
        if !is_empty(&r) {
            out.insert(k.clone(), r);
        }
    }
    Ok(Value::Object(out))
}

struct Rendered {
    client: Value,
    scope: Value,
    container: Vec<String>,
    launcher_id: String,
    launcher: Value,
    server_name: String,
    entry: Value,
    document: Value,
}

fn render_config(reg: &Value, client: &Value, args: &McpConfigArgs) -> Result<Rendered, Failure> {
    let scope = scope_by_id(client, args.scope.as_deref())?;
    let (launcher_id, launcher) = launcher_by_id(reg, args.launcher.as_deref())?;
    let server_name = args
        .server_name
        .clone()
        .or_else(|| reg["serverName"].as_str().map(String::from))
        .unwrap_or_else(|| "medha".to_string());
    let sub = |s: &str| s.replace(VERSION_PLACEHOLDER, VERSION);
    let argv: Vec<String> = launcher["argv"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(sub)).collect())
        .unwrap_or_default();
    let env: Map<String, Value> = launcher["env"]
        .as_object()
        .map(|m| {
            m.iter()
                .map(|(k, v)| (k.clone(), json!(sub(v.as_str().unwrap_or("")))))
                .collect()
        })
        .unwrap_or_default();
    let where_ = client["id"].as_str().unwrap_or("").to_string();
    let ctx = Ctx {
        argv,
        env,
        server_name: &server_name,
        where_: &where_,
    };
    let template = client["document"]["template"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let entry = resolve_object(&template, &ctx)?;
    if entry.get("command").is_none() && entry.get("url").is_none() {
        return Err(registry_error(
            format!("client '{where_}' renders a server entry with neither 'command' nor 'url'"),
            "every template must produce a launchable server entry",
        ));
    }
    let container = container_for(client, &scope);
    let mut document = json!({ server_name.clone(): entry.clone() });
    for key in container.iter().rev() {
        document = json!({ key.clone(): document });
    }
    Ok(Rendered {
        client: client.clone(),
        scope,
        container,
        launcher_id,
        launcher,
        server_name,
        entry,
        document,
    })
}

fn text_of(doc: &Value) -> String {
    format!(
        "{}\n",
        serde_json::to_string_pretty(doc).unwrap_or_default()
    )
}

fn snippet_report(r: &Rendered) -> Value {
    let mut v = json!({
        "clientId": r.client["id"],
        "clientName": r.client["name"],
        "docs": r.client["docs"],
    });
    if let Some(n) = r.client["notes"].as_str() {
        v["notes"] = json!(n);
    }
    for (k, val) in [
        ("scopeId", r.scope["id"].clone()),
        ("scopeLabel", r.scope["label"].clone()),
        ("path", json!(display_path(&r.scope["path"]))),
        ("launcherId", json!(r.launcher_id)),
        ("launcherLabel", r.launcher["label"].clone()),
        ("serverName", json!(r.server_name)),
        ("document", r.document.clone()),
        ("text", json!(text_of(&r.document))),
    ] {
        v[k] = val;
    }
    v
}

fn render_snippet(r: &Value) -> String {
    let mut head = vec![
        format!(
            "{} ({}) — scope: {} ({})",
            r["clientName"].as_str().unwrap_or(""),
            r["clientId"].as_str().unwrap_or(""),
            r["scopeId"].as_str().unwrap_or(""),
            r["scopeLabel"].as_str().unwrap_or("")
        ),
        format!("  config file: {}", r["path"].as_str().unwrap_or("")),
        format!(
            "  launcher:    {}",
            r["launcherLabel"].as_str().unwrap_or("")
        ),
        format!("  docs:        {}", r["docs"].as_str().unwrap_or("")),
    ];
    if let Some(n) = r["notes"].as_str() {
        head.push(format!("  note:        {n}"));
    }
    head.push(String::new());
    head.push(r["text"].as_str().unwrap_or("").trim_end().to_string());
    head.join("\n")
}

fn list_report(reg: &Value) -> Value {
    let rows: Vec<Value> = clients(reg)
        .iter()
        .map(|c| {
            let mut row = json!({ "id": c["id"], "name": c["name"], "docs": c["docs"] });
            if let Some(n) = c["notes"].as_str() {
                row["notes"] = json!(n);
            }
            row["scopes"] = json!(c["scopes"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|s| json!({ "id": s["id"], "label": s["label"], "path": display_path(&s["path"]) }))
                .collect::<Vec<_>>());
            row
        })
        .collect();
    let launchers: Vec<Value> = reg["launchers"]
        .as_object()
        .map(|m| {
            m.iter()
                .map(|(id, l)| json!({ "id": id, "label": l["label"] }))
                .collect()
        })
        .unwrap_or_default();
    json!({ "clients": rows, "launchers": launchers })
}

fn render_list(report: &Value) -> String {
    let mut lines = vec!["Supported MCP clients:".to_string()];
    for c in report["clients"].as_array().cloned().unwrap_or_default() {
        lines.push(format!(
            "  {} — {}",
            c["id"].as_str().unwrap_or(""),
            c["name"].as_str().unwrap_or("")
        ));
        lines.push(format!("    docs: {}", c["docs"].as_str().unwrap_or("")));
        for s in c["scopes"].as_array().cloned().unwrap_or_default() {
            lines.push(format!(
                "    {}  {}",
                s["id"].as_str().unwrap_or(""),
                s["path"].as_str().unwrap_or("")
            ));
        }
        if let Some(n) = c["notes"].as_str() {
            lines.push(format!("    note: {n}"));
        }
    }
    lines.push("Launchers:".to_string());
    for l in report["launchers"].as_array().cloned().unwrap_or_default() {
        lines.push(format!(
            "  {} — {}",
            l["id"].as_str().unwrap_or(""),
            l["label"].as_str().unwrap_or("")
        ));
    }
    lines.join("\n")
}

/// Merge the rendered entry into the client's config file, keeping every other key (TypeScript
/// `writeClientConfig`). The file is rewritten only when its bytes would change.
fn write_config(r: &Rendered, cwd: &Path) -> Res<Value> {
    let path = resolve_path(&r.scope["path"], cwd)?;
    let exists = path.exists();
    let previous = if exists {
        Some(fs::read_to_string(&path)?)
    } else {
        None
    };
    let mut doc = match &previous {
        Some(text) => {
            let config_error = |problem: &str| {
                Failure::cli(
                    "ConfigFileError",
                    "CLI_CONFIG_INVALID",
                    format!("cannot read {}: {problem}", path.display()),
                )
            };
            let parsed: Value =
                serde_json::from_str(text).map_err(|_| config_error("not valid JSON"))?;
            if !parsed.is_object() {
                return Err(Box::new(config_error("expected a JSON object at the root")));
            }
            parsed
        }
        None => json!({}),
    };
    let mut node = &mut doc;
    let mut keys = r.container.clone();
    keys.push(r.server_name.clone());
    let leaf = keys.pop().unwrap_or_default();
    for key in &keys {
        if node.get(key).is_none() {
            node[key] = json!({});
        }
        if !node[key].is_object() {
            return Err(Box::new(registry_error(
                format!(
                    "cannot merge into '{}': '{key}' is not a JSON object",
                    r.container.join(".")
                ),
                "the target file holds something unexpected where the server map should be",
            )));
        }
        node = &mut node[key];
    }
    node[leaf] = r.entry.clone();
    let text = text_of(&doc);
    let changed = previous.as_deref() != Some(text.as_str());
    if changed {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, &text)?;
    }
    Ok(json!({
        "clientId": r.client["id"],
        "clientName": r.client["name"],
        "scopeId": r.scope["id"],
        "launcherId": r.launcher_id,
        "serverName": r.server_name,
        "path": path.display().to_string(),
        "created": !exists,
        "changed": changed,
    }))
}

fn render_write(r: &Value) -> String {
    let state = if r["created"] == true {
        "created"
    } else if r["changed"] == true {
        "updated"
    } else {
        "no change"
    };
    [
        format!(
            "{} ({}) — scope: {}, launcher: {}",
            r["clientName"].as_str().unwrap_or(""),
            r["clientId"].as_str().unwrap_or(""),
            r["scopeId"].as_str().unwrap_or(""),
            r["launcherId"].as_str().unwrap_or("")
        ),
        format!("  config file: {}", r["path"].as_str().unwrap_or("")),
        format!("  server key:  {}", r["serverName"].as_str().unwrap_or("")),
        format!("  result:      {state}"),
    ]
    .join("\n")
}

pub fn run_mcp_config(args: &McpConfigArgs, json_mode: bool, dir: Option<&str>) -> Res<()> {
    let reg = registry()?;
    let out = |value: &Value, text: String| -> Res<()> {
        if json_mode {
            println!("{}", serde_json::to_string_pretty(value)?);
        } else {
            println!("{text}");
        }
        Ok(())
    };
    if args.list {
        let report = list_report(&reg);
        return out(&report, render_list(&report));
    }
    if args.all && args.write {
        return Err(Box::new(Failure::invalid(
            "--all",
            "no --write alongside it (write one client at a time)",
            "--write",
        )));
    }
    if args.all {
        let mut reports = Vec::new();
        for c in clients(&reg) {
            reports.push(snippet_report(&render_config(&reg, &c, args)?));
        }
        let text = reports
            .iter()
            .map(render_snippet)
            .collect::<Vec<_>>()
            .join("\n\n");
        return out(&json!(reports), text);
    }
    let Some(client_id) = args.client.as_deref().filter(|c| !c.is_empty()) else {
        return Err(Box::new(Failure::invalid(
            "client",
            "a client id (or --list for the ids, --all for every snippet)",
            args.client.as_deref().unwrap_or("none"),
        )));
    };
    let client = client_by_id(&reg, client_id)?;
    let rendered = render_config(&reg, &client, args)?;
    if args.write {
        let cwd = dir
            .map(PathBuf::from)
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| PathBuf::from("."));
        let report = write_config(&rendered, &cwd)?;
        return out(&report, render_write(&report));
    }
    let report = snippet_report(&rendered);
    out(&report, render_snippet(&report))
}
