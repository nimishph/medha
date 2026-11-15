use crate::args::McpConfigArgs;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

const BUNDLED_CLIENTS_JSON: &str = include_str!("../../../cli/src/integrations/clients.json");

pub fn run_mcp_config(args: &McpConfigArgs, json_mode: bool) -> Result<(), Box<dyn std::error::Error>> {
    let registry: Value = serde_json::from_str(BUNDLED_CLIENTS_JSON)?;

    if args.list {
        let clients_arr = registry.get("clients").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let launchers_obj = registry.get("launchers").and_then(|v| v.as_object()).cloned().unwrap_or_default();

        let client_rows: Vec<Value> = clients_arr
            .iter()
            .map(|c| {
                let id = c.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let name = c.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let docs = c.get("docs").and_then(|v| v.as_str()).unwrap_or("");
                let notes = c.get("notes").and_then(|v| v.as_str());
                let scopes: Vec<Value> = c
                    .get("scopes")
                    .and_then(|v| v.as_array())
                    .unwrap_or(&vec![])
                    .iter()
                    .map(|s| {
                        let sid = s.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        let label = s.get("label").and_then(|v| v.as_str()).unwrap_or("");
                        let path = s.get("path").and_then(|v| {
                            if v.is_string() {
                                v.as_str()
                            } else {
                                v.get("default").and_then(|d| d.as_str())
                            }
                        }).unwrap_or("");
                        json!({ "id": sid, "label": label, "path": path })
                    })
                    .collect();
                let mut row = json!({
                    "id": id,
                    "name": name,
                    "docs": docs,
                    "scopes": scopes,
                });
                if let Some(n) = notes {
                    row["notes"] = json!(n);
                }
                row
            })
            .collect();

        let launcher_rows: Vec<Value> = launchers_obj
            .iter()
            .map(|(id, l)| {
                json!({
                    "id": id,
                    "label": l.get("label").and_then(|v| v.as_str()).unwrap_or(""),
                })
            })
            .collect();

        let report = json!({
            "clients": client_rows,
            "launchers": launcher_rows,
        });

        if json_mode {
            println!("{}", serde_json::to_string_pretty(&report)?);
        } else {
            println!("MCP clients ({}):", client_rows.len());
            for c in &client_rows {
                let id = c.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let name = c.get("name").and_then(|v| v.as_str()).unwrap_or("");
                println!("  {:16} {}", id, name);
            }
            println!("\nLaunchers ({}):", launcher_rows.len());
            for l in &launcher_rows {
                let id = l.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let label = l.get("label").and_then(|v| v.as_str()).unwrap_or("");
                println!("  {:16} {}", id, label);
            }
        }
        return Ok(());
    }

    if args.all && args.write {
        eprintln!("medha error: --all cannot be combined with --write (write one client at a time)");
        std::process::exit(2);
    }

    if args.all {
        let clients_arr = registry.get("clients").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let mut reports = Vec::new();
        for client in &clients_arr {
            let cid = client.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let rep = render_snippet(&registry, cid, args.launcher.as_deref(), args.server_name.as_deref())?;
            reports.push(rep);
        }
        if json_mode {
            println!("{}", serde_json::to_string_pretty(&reports)?);
        } else {
            for (idx, rep) in reports.iter().enumerate() {
                if idx > 0 {
                    println!();
                }
                println!("{}", rep["text"].as_str().unwrap_or(""));
            }
        }
        return Ok(());
    }

    let client_id = match args.client.as_deref() {
        Some(c) if !c.is_empty() => c,
        _ => {
            eprintln!("Usage: medha mcp config <client> | --list | --all\nRun `medha mcp config --list` to see available clients.");
            std::process::exit(2);
        }
    };

    let snippet = render_snippet(&registry, client_id, args.launcher.as_deref(), args.server_name.as_deref())?;

    if args.write {
        let path_str = snippet["path"].as_str().unwrap_or("");
        let dest = resolve_config_path(path_str);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        let doc = snippet["document"].clone();
        let pretty = serde_json::to_string_pretty(&doc)?;
        fs::write(&dest, pretty)?;
        if json_mode {
            println!("{}", serde_json::to_string_pretty(&json!({
                "clientId": client_id,
                "clientName": snippet["clientName"],
                "scopeId": snippet["scopeId"],
                "launcherId": snippet["launcherId"],
                "serverName": snippet["serverName"],
                "path": dest.display().to_string(),
                "created": true,
                "changed": true,
            }))?);
        } else {
            println!("medha: wrote MCP configuration for {} to {}", snippet["clientName"].as_str().unwrap_or(""), dest.display());
        }
        return Ok(());
    }

    if json_mode {
        println!("{}", serde_json::to_string_pretty(&snippet)?);
    } else {
        println!("{}", snippet["text"].as_str().unwrap_or(""));
    }

    Ok(())
}

fn resolve_config_path(raw: &str) -> PathBuf {
    if raw.starts_with("~/") || raw.starts_with("~\\") {
        if let Some(home) = dirs_home() {
            return home.join(&raw[2..]);
        }
    }
    if raw.starts_with("%APPDATA%/") || raw.starts_with("%APPDATA%\\") {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata).join(&raw[10..]);
        }
    }
    PathBuf::from(raw)
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

fn render_snippet(
    registry: &Value,
    client_id: &str,
    launcher_id: Option<&str>,
    server_name: Option<&str>,
) -> Result<Value, Box<dyn std::error::Error>> {
    let clients = registry.get("clients").and_then(|v| v.as_array()).ok_or("No clients in registry")?;
    let client = clients
        .iter()
        .find(|c| c.get("id").and_then(|v| v.as_str()) == Some(client_id))
        .ok_or_else(|| format!("Unknown client '{}'. Run `medha mcp config --list` to see available clients.", client_id))?;

    let client_name = client.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let docs = client.get("docs").and_then(|v| v.as_str()).unwrap_or("");
    let s_name = server_name.unwrap_or("medha");

    let l_id = launcher_id.unwrap_or("path");
    let (cmd, args_vec) = if l_id == "npx" {
        ("npx", vec!["-y".to_string(), "@cntxt-labs/medha-cli@latest".to_string(), "mcp".to_string(), "serve".to_string()])
    } else {
        ("medha", vec!["mcp".to_string(), "serve".to_string()])
    };

    let scopes = client.get("scopes").and_then(|v| v.as_array()).ok_or("No scopes")?;
    let scope = scopes.first().ok_or("No scope")?;
    let scope_id = scope.get("id").and_then(|v| v.as_str()).unwrap_or("project");
    let scope_label = scope.get("label").and_then(|v| v.as_str()).unwrap_or("Project");
    let scope_path = scope.get("path").and_then(|v| {
        if v.is_string() {
            v.as_str()
        } else {
            v.get("default").and_then(|d| d.as_str())
        }
    }).unwrap_or("");

    let doc = json!({
        "mcpServers": {
            s_name: {
                "command": cmd,
                "args": args_vec,
            }
        }
    });

    let text = format!(
        "// {} ({}, {})\n{}",
        client_name,
        scope_label,
        scope_path,
        serde_json::to_string_pretty(&doc)?
    );

    Ok(json!({
        "clientId": client_id,
        "clientName": client_name,
        "docs": docs,
        "scopeId": scope_id,
        "scopeLabel": scope_label,
        "path": scope_path,
        "launcherId": l_id,
        "launcherLabel": if l_id == "npx" { "npx (pinned)" } else { "medha on PATH" },
        "serverName": s_name,
        "document": doc,
        "text": text,
    }))
}
