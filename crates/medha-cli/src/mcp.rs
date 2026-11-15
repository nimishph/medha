use medha::core::types::EntityKey;
use medha::store::StorePort;
use medha::{GuardInput, MedhaEngine, RecordInput};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Option<Value>,
}

pub fn run_mcp_server<S: StorePort>(mut engine: MedhaEngine<S>) -> io::Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = stdin.lock();
    let mut writer = stdout.lock();

    let mut line = String::new();
    while reader.read_line(&mut line)? > 0 {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            if let Ok(req) = serde_json::from_str::<JsonRpcRequest>(trimmed) {
                let resp = handle_request(&mut engine, req);
                if let Some(r) = resp {
                    let out_json = serde_json::to_string(&r)?;
                    writer.write_all(out_json.as_bytes())?;
                    writer.write_all(b"\n")?;
                    writer.flush()?;
                }
            }
        }
        line.clear();
    }

    Ok(())
}

fn handle_request<S: StorePort>(engine: &mut MedhaEngine<S>, req: JsonRpcRequest) -> Option<Value> {
    let id = req.id?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    match req.method.as_str() {
        "initialize" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {}
                },
                "serverInfo": {
                    "name": "medha",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }
        })),
        "notifications/initialized" => None,
        "tools/list" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "tools": [
                    {
                        "name": "hints",
                        "description": "Batch fetch hints for entity keys. Returns evidential trust hints.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "keys": {
                                    "type": "array",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "namespace": { "type": "string" },
                                            "kind": { "type": "string" },
                                            "id": { "type": "string" }
                                        },
                                        "required": ["id"]
                                    }
                                }
                            },
                            "required": ["keys"]
                        }
                    },
                    {
                        "name": "list_entities",
                        "description": "List all entities and their evidential trust hints.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "kind": { "type": "string" },
                                "namespace": { "type": "string" },
                                "ids": {
                                    "type": "array",
                                    "items": { "type": "string" },
                                    "description": "Only these entity ids (e.g. the rules your host still has)."
                                }
                            }
                        }
                    },
                    {
                        "name": "propose",
                        "description": "Propose a candidate rule or entity (enters on probation).",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "id": { "type": "string" },
                                "kind": { "type": "string" },
                                "namespace": { "type": "string" },
                                "source": { "type": "string" },
                                "theta0": { "type": "number" },
                                "description": { "type": "string" }
                            },
                            "required": ["id"]
                        }
                    },
                    {
                        "name": "show_entity",
                        "description": "Show complete evidential breakdown and recent history for an entity.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "id": { "type": "string" },
                                "kind": { "type": "string" },
                                "namespace": { "type": "string" }
                            },
                            "required": ["id"]
                        }
                    },
                    {
                        "name": "record_signal",
                        "description": "Record an observed outcome (APPLY, REJECT_RULE, etc.) on an entity.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "id": { "type": "string" },
                                "kind": { "type": "string" },
                                "namespace": { "type": "string" },
                                "signal": { "type": "string" },
                                "author": { "type": "string" },
                                "note": { "type": "string" }
                            },
                            "required": ["id", "signal"]
                        }
                    },
                    {
                        "name": "report_guard",
                        "description": "Report verification or automated test guard check results.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "id": { "type": "string" },
                                "kind": { "type": "string" },
                                "namespace": { "type": "string" },
                                "ok": { "type": "boolean" },
                                "guard": { "type": "string" },
                                "note": { "type": "string" }
                            },
                            "required": ["id", "ok"]
                        }
                    },
                    {
                        "name": "simulate",
                        "description": "Simulate the trust delta and status trajectory of a prospective signal without recording.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "id": { "type": "string" },
                                "kind": { "type": "string" },
                                "namespace": { "type": "string" },
                                "signal": { "type": "string" }
                            },
                            "required": ["id", "signal"]
                        }
                    },
                    {
                        "name": "explain_threshold",
                        "description": "Explain which threshold bars are cleared and which are not.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "id": { "type": "string" },
                                "kind": { "type": "string" },
                                "namespace": { "type": "string" }
                            },
                            "required": ["id"]
                        }
                    },
                    {
                        "name": "record_decision",
                        "description": "Grow or edit one branch of an entity's decision tree: condition and decision.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "id": { "type": "string" },
                                "kind": { "type": "string" },
                                "namespace": { "type": "string" },
                                "condition": { "type": "string" },
                                "caseId": { "type": "string" },
                                "parentId": { "type": "string" },
                                "decision": { "type": "object" }
                            },
                            "required": ["id", "condition", "decision"]
                        }
                    },
                    {
                        "name": "drift",
                        "description": "List entities currently experiencing weight drift, ordered by most-drifted first.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "limit": { "type": "integer" }
                            }
                        }
                    },
                    {
                        "name": "status",
                        "description": "Engine health report: preflight integrity, distribution by lifecycle status, drift count.",
                        "inputSchema": {
                            "type": "object"
                        }
                    },
                    {
                        "name": "retract_episode",
                        "description": "Retract an erroneous episode by sequence number, appending a masking retract episode.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "seq": { "type": "integer" },
                                "reason": { "type": "string" }
                            },
                            "required": ["seq"]
                        }
                    },
                    {
                        "name": "remove_episode",
                        "description": "Hard-delete an episode from store log and resequence the rest.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "seq": { "type": "integer" }
                            },
                            "required": ["seq"]
                        }
                    },
                    {
                        "name": "pack_context",
                        "description": "Pack trusted, active and probation entities (rules, tools) into an evidential context window within a token budget; quarantined and retired ones are left out.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "budget": { "type": "integer" },
                                "kind": { "type": "string" },
                                "namespace": { "type": "string" },
                                "ids": {
                                    "type": "array",
                                    "items": { "type": "string" },
                                    "description": "Only these entity ids, so retired or deleted host rules are never packed."
                                },
                                "explorationRatio": { "type": "number" },
                                "seed": { "type": "integer" },
                                "format": { "type": "string" }
                            },
                            "required": ["budget"]
                        }
                    },
                    {
                        "name": "primer",
                        "description": "Token-frugal guidance on Medha concepts, architecture, signals, guards, decisions, drift, config, or sync.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "topic": { "type": "string" }
                            }
                        }
                    },
                    {
                        "name": "hints_for_context",
                        "description": "Context-aware hint matching: selectively fetches and packs rules relevant to active files, language, or task query (medha-c8z.1).",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "files": { "type": "array", "items": { "type": "string" } },
                                "languages": { "type": "array", "items": { "type": "string" } },
                                "query": { "type": "string" },
                                "budget": { "type": "integer" },
                                "kind": { "type": "string" },
                                "compact": { "type": "boolean" }
                            }
                        }
                    },
                    {
                        "name": "verify_guard",
                        "description": "Evaluate or execute an automated verification guard check on an entity, recording pass/fail outcome into memory (medha-c8z.2).",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "id": { "type": "string" },
                                "guard": { "type": "string" },
                                "ok": { "type": "boolean" },
                                "command": { "type": "string" },
                                "kind": { "type": "string" },
                                "namespace": { "type": "string" }
                            },
                            "required": ["id"]
                        }
                    },
                    {
                        "name": "detect_pitfalls",
                        "description": "Negative-evidence radar: detect known traps, anti-patterns, and repeatedly failing rules or guards (medha-c8z.4).",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "minFailures": { "type": "integer" },
                                "kind": { "type": "string" },
                                "namespace": { "type": "string" },
                                "limit": { "type": "integer" }
                            }
                        }
                    },
                    {
                        "name": "distill_trajectory",
                        "description": "Autonomous session retrospective distillation: extracts empirical lessons from incident trajectories into candidate rules with commit anchors (medha-c8z.5).",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "id": { "type": "string" },
                                "title": { "type": "string" },
                                "commitSha": { "type": "string" },
                                "lessons": { "type": "array", "items": { "type": "object" } },
                                "autoFile": { "type": "boolean" }
                            },
                            "required": ["id", "title"]
                        }
                    },
                    {
                        "name": "policy_latch",
                        "description": "Regulated agent compliance policy gateway: checks Medha decision trees and requireHumanFor gating before high-risk mutations execute (medha-534).",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "id": { "type": "string" },
                                "kind": { "type": "string" },
                                "namespace": { "type": "string" },
                                "context": {},
                                "author": { "type": "string" },
                                "action": { "type": "string" },
                                "minTrust": { "type": "number" },
                                "compact": { "type": "boolean" }
                            },
                            "required": ["id"]
                        }
                    }
                ]
            }
        })),
        "tools/call" => {
            let params = req.params.unwrap_or(json!({}));
            let tool_name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));

            let is_compact = args
                .get("compact")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let result_val = run_tool(engine, tool_name, &args, now);
            match result_val {
                Ok(content_json) => {
                    let text = if is_compact {
                        serde_json::to_string(&content_json).unwrap_or_default()
                    } else {
                        serde_json::to_string_pretty(&content_json).unwrap_or_default()
                    };
                    Some(json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "content": [
                                {
                                    "type": "text",
                                    "text": text
                                }
                            ]
                        }
                    }))
                }
                Err(err_msg) => Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "isError": true,
                        "content": [
                            {
                                "type": "text",
                                "text": err_msg
                            }
                        ]
                    }
                })),
            }
        }
        _ => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": -32601,
                "message": "Method not found"
            }
        })),
    }
}

fn compact_hint(h: &medha::core::types::TrustHint) -> Value {
    json!({
        "key": h.key,
        "trust": (h.trust * 1000.0).round() / 1000.0,
        "status": format!("{:?}", h.status).to_lowercase(),
        "drifting": h.is_drifting,
    })
}

fn run_tool<S: StorePort>(
    engine: &mut MedhaEngine<S>,
    tool_name: &str,
    args: &Value,
    now: i64,
) -> Result<Value, String> {
    match tool_name {
        "hints" => {
            let keys_val = args.get("keys").and_then(|v| v.as_array());
            let compact = args
                .get("compact")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if let Some(keys_arr) = keys_val {
                let mut entity_keys = Vec::new();
                for item in keys_arr {
                    let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    let kind = item.get("kind").and_then(|v| v.as_str()).unwrap_or("rule");
                    let ns = item.get("namespace").and_then(|v| v.as_str()).unwrap_or("");
                    entity_keys.push(EntityKey::new(ns, kind, id));
                }
                let mut unknown = Vec::new();
                for k in &entity_keys {
                    if engine.get(k).map_err(|e| e.to_string())?.is_none() {
                        unknown.push(k.clone());
                    }
                }
                match engine.hints(&entity_keys, now) {
                    Ok(hints) => {
                        if compact {
                            let compact_hints: Vec<Value> =
                                hints.iter().map(compact_hint).collect();
                            Ok(json!({ "hints": compact_hints, "unknown": unknown }))
                        } else {
                            Ok(json!({ "hints": hints, "unknown": unknown }))
                        }
                    }
                    Err(e) => Err(e.to_string()),
                }
            } else {
                Err("Missing 'keys' parameter".to_string())
            }
        }
        "list_entities" => match engine.list() {
            Ok(states) => {
                let ids = string_list(args.get("ids"));
                let filter_kind = args.get("kind").and_then(|v| v.as_str());
                let filter_status = args.get("status").and_then(|v| v.as_str());
                let filter_ns = args.get("namespace").and_then(|v| v.as_str());
                let filter_drifting = args
                    .get("drifting")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let compact = args
                    .get("compact")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let mut hints = Vec::new();
                for s in states {
                    if let Some(ref ids) = ids {
                        if !ids.contains(&s.key.id) {
                            continue;
                        }
                    }
                    if let Some(k) = filter_kind {
                        if s.key.kind != k {
                            continue;
                        }
                    }
                    if let Some(ns) = filter_ns {
                        if s.key.namespace != ns {
                            continue;
                        }
                    }
                    if let Ok(h) = engine.hint(&s.key, now) {
                        if filter_drifting && !h.is_drifting {
                            continue;
                        }
                        if let Some(st) = filter_status {
                            if format!("{:?}", h.status).to_lowercase() != st {
                                continue;
                            }
                        }
                        hints.push(h);
                    }
                }
                let total = hints.len();
                if compact {
                    let items: Vec<Value> = hints.iter().map(compact_hint).collect();
                    Ok(json!({ "items": items, "total": total, "hasMore": false }))
                } else {
                    Ok(json!({ "items": hints, "total": total, "hasMore": false }))
                }
            }
            Err(e) => Err(e.to_string()),
        },
        "propose" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let kind = args.get("kind").and_then(|v| v.as_str()).unwrap_or("rule");
            let ns = args.get("namespace").and_then(|v| v.as_str()).unwrap_or("");
            let key = EntityKey::new(ns, kind, id);
            let source = args.get("source").and_then(|v| v.as_str()).unwrap_or("mcp");
            let theta0 = args.get("theta0").and_then(|v| v.as_f64());
            let desc = args
                .get("description")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            match engine.propose(&key, source, theta0, desc, now) {
                Ok(res) => Ok(json!(res)),
                Err(e) => Err(e.to_string()),
            }
        }
        "show_entity" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let kind = args.get("kind").and_then(|v| v.as_str()).unwrap_or("rule");
            let ns = args.get("namespace").and_then(|v| v.as_str()).unwrap_or("");
            let key = EntityKey::new(ns, kind, id);
            match engine.show(&key, now) {
                Ok(show) => Ok(json!(show)),
                Err(e) => Err(e.to_string()),
            }
        }
        "record_signal" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let kind = args.get("kind").and_then(|v| v.as_str()).unwrap_or("rule");
            let ns = args.get("namespace").and_then(|v| v.as_str()).unwrap_or("");
            let signal = args
                .get("signal")
                .and_then(|v| v.as_str())
                .unwrap_or("APPLY");
            let author = args
                .get("author")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let note = args
                .get("note")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let ensure = args
                .get("ensure")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let compact = args
                .get("compact")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            let key = EntityKey::new(ns, kind, id);
            let exists = engine.get(&key).map_err(|e| e.to_string())?.is_some();
            if !exists && !ensure {
                let hint = engine.hint(&key, now).map_err(|e| e.to_string())?;
                let hint_val = if compact {
                    compact_hint(&hint)
                } else {
                    json!(hint)
                };
                return Ok(json!({
                    "recorded": false,
                    "note": "entity is unknown and `ensure` was not set: nothing was recorded; the hint is a probation prior. Pass ensure: true to create it.",
                    "hint": hint_val
                }));
            }

            let input = RecordInput {
                key: key.clone(),
                signal: signal.to_string(),
                at: now,
                ensure,
                author,
                anchors: None,
                run_ref: None,
                note,
                case_id: args
                    .get("caseId")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
            };

            let res = engine.record(input).map_err(|e| e.to_string())?;
            let hint = engine.hint(&key, now).map_err(|e| e.to_string())?;
            let hint_val = if compact {
                compact_hint(&hint)
            } else {
                json!(hint)
            };
            Ok(json!({
                "recorded": true,
                "hint": hint_val,
                "episode": res.episode
            }))
        }
        "report_guard" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let kind = args.get("kind").and_then(|v| v.as_str()).unwrap_or("rule");
            let ns = args.get("namespace").and_then(|v| v.as_str()).unwrap_or("");
            let ok = args.get("ok").and_then(|v| v.as_bool()).unwrap_or(true);
            let guard_kind = args
                .get("guard")
                .or_else(|| args.get("guardKind"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let note = args
                .get("note")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let key = EntityKey::new(ns, kind, id);
            if guard_kind.as_deref().is_none_or(|k| k.trim().is_empty()) {
                let has_guard = engine
                    .get(&key)
                    .map_err(|e| e.to_string())?
                    .is_some_and(|s| !s.guard.kind.is_empty() && s.guard.kind != "none");
                if !has_guard {
                    return Err(format!(
                        "{} has no guard yet, so a report without `guard` would not count; pass guard (e.g. ci, review, tests)",
                        key.to_string_repr()
                    ));
                }
            }

            let input = GuardInput {
                key: key.clone(),
                ok,
                kind: guard_kind,
                at: now,
                author: args
                    .get("author")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                note,
            };

            let _ = engine.guard(input).map_err(|e| e.to_string())?;
            let hint = engine.hint(&key, now).map_err(|e| e.to_string())?;
            Ok(json!(hint))
        }
        "simulate" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let kind = args.get("kind").and_then(|v| v.as_str()).unwrap_or("rule");
            let ns = args.get("namespace").and_then(|v| v.as_str()).unwrap_or("");
            let signal = args
                .get("signal")
                .and_then(|v| v.as_str())
                .unwrap_or("APPLY");
            let key = EntityKey::new(ns, kind, id);

            match engine.simulate(&key, signal, now) {
                Ok(res) => Ok(json!(res)),
                Err(e) => Err(e.to_string()),
            }
        }
        "explain_threshold" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let kind = args.get("kind").and_then(|v| v.as_str()).unwrap_or("rule");
            let ns = args.get("namespace").and_then(|v| v.as_str()).unwrap_or("");
            let key = EntityKey::new(ns, kind, id);

            match engine.explain_threshold(&key, now) {
                Ok(res) => Ok(json!(res)),
                Err(e) => Err(e.to_string()),
            }
        }
        "record_decision" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let kind = args.get("kind").and_then(|v| v.as_str()).unwrap_or("rule");
            let ns = args.get("namespace").and_then(|v| v.as_str()).unwrap_or("");
            let condition = args.get("condition").and_then(|v| v.as_str()).unwrap_or("");
            let case_id = args
                .get("caseId")
                .and_then(|v| v.as_str())
                .unwrap_or("case-default");
            let parent_id = args
                .get("parentId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let dec_type = args
                .get("decision")
                .and_then(|v| v.get("type"))
                .and_then(|t| t.as_str())
                .unwrap_or("apply");
            let decision = match dec_type {
                "ignore" => medha::core::decision::Decision::Ignore,
                "probability" => {
                    let p = args
                        .get("decision")
                        .and_then(|v| v.get("value"))
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.5);
                    medha::core::decision::Decision::Probability { value: p }
                }
                _ => medha::core::decision::Decision::Apply,
            };
            let key = EntityKey::new(ns, kind, id);
            match engine.decision(&key, case_id, parent_id, condition, decision, now) {
                Ok(res) => Ok(json!(res)),
                Err(e) => Err(e.to_string()),
            }
        }
        "drift" => {
            let limit = args
                .get("limit")
                .and_then(|v| v.as_u64())
                .map(|n| n as usize);
            let all_states = engine.list().map_err(|e| e.to_string())?;
            let mut drifting = Vec::new();
            for s in all_states {
                if let Ok(h) = engine.hint(&s.key, now) {
                    if h.is_drifting {
                        drifting.push(h);
                    }
                }
            }
            if let Some(lim) = limit {
                drifting.truncate(lim);
            }
            Ok(json!(drifting))
        }
        "status" => {
            let preflight = engine.preflight().map_err(|e| e.to_string())?;
            let states = engine.list().map_err(|e| e.to_string())?;
            let mut by_status = std::collections::HashMap::new();
            by_status.insert("probation", 0);
            by_status.insert("active", 0);
            by_status.insert("trusted", 0);
            by_status.insert("quarantined", 0);
            by_status.insert("retired", 0);
            let mut drifting_count = 0;
            for state in &states {
                if let Ok(hint) = engine.hint(&state.key, now) {
                    let s_str = match hint.status {
                        medha::core::types::LifecycleStatus::Probation => "probation",
                        medha::core::types::LifecycleStatus::Active => "active",
                        medha::core::types::LifecycleStatus::Trusted => "trusted",
                        medha::core::types::LifecycleStatus::Quarantined => "quarantined",
                        medha::core::types::LifecycleStatus::Retired => "retired",
                    };
                    *by_status.entry(s_str).or_insert(0) += 1;
                    if hint.is_drifting {
                        drifting_count += 1;
                    }
                }
            }
            Ok(json!({
                "preflight": preflight,
                "byStatus": by_status,
                "driftingCount": drifting_count,
                "totalEntities": states.len()
            }))
        }
        "retract_episode" => {
            let seq = match args.get("seq").and_then(|v| v.as_u64()) {
                Some(s) => s,
                None => return Err("Missing 'seq' argument".to_string()),
            };
            let reason = args
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or("User requested retraction");
            // Given the entity, a seq from another one is refused (gh-22).
            let expect = args.get("id").and_then(|v| v.as_str()).map(|id| {
                EntityKey::new(
                    args.get("namespace").and_then(|v| v.as_str()).unwrap_or(""),
                    args.get("kind").and_then(|v| v.as_str()).unwrap_or("rule"),
                    id,
                )
            });
            match engine.retract_checked(seq, reason, now, expect.as_ref()) {
                Ok(res) => {
                    let mut out = json!({ "retractedSeq": seq, "episode": res.appended.episode });
                    if let Some(lifted) = res.lifted {
                        out["lifted"] = json!(lifted);
                    }
                    Ok(out)
                }
                Err(e) => Err(e.to_string()),
            }
        }
        "remove_episode" => {
            let seq = match args.get("seq").and_then(|v| v.as_u64()) {
                Some(s) => s,
                None => return Err("Missing 'seq' argument".to_string()),
            };
            match engine.remove_episode(seq) {
                Ok(_) => Ok(json!({ "removedSeq": seq, "ok": true })),
                Err(e) => Err(e.to_string()),
            }
        }
        "pack_context" => {
            let budget = args.get("budget").and_then(|v| v.as_u64()).unwrap_or(2000) as usize;
            let kind = args
                .get("kind")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let namespace = args
                .get("namespace")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let exploration_ratio = args
                .get("explorationRatio")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.15);
            let seed = args.get("seed").and_then(|v| v.as_u64());
            let format = args
                .get("format")
                .and_then(|v| v.as_str())
                .unwrap_or("markdown");
            let opts = medha::EnginePackOptions {
                budget,
                kind,
                namespace,
                ids: string_list(args.get("ids")),
                exploration_ratio,
                seed,
                min_trust: 0.0,
                allow_quarantined: false,
                allow_retired: false,
            };
            match engine.pack(opts, now) {
                Ok(outcome) => {
                    if format == "json" {
                        Ok(json!(outcome))
                    } else {
                        let report = crate::pack::PackReport {
                            home: String::new(),
                            budget,
                            outcome: outcome.clone(),
                            format: format.to_string(),
                        };
                        let text = crate::pack::render_pack(&report);
                        Ok(json!({
                            "budget": budget,
                            "totalCost": outcome.total_cost,
                            "utilization": outcome.utilization,
                            "selectedCount": outcome.selected.len(),
                            "contextText": text,
                            "outcome": outcome
                        }))
                    }
                }
                Err(e) => Err(e.to_string()),
            }
        }
        "primer" => {
            let topic = args.get("topic").and_then(|v| v.as_str());
            match crate::primer::get_primer(topic) {
                Ok(res) => Ok(json!(res)),
                Err(e) => Err(e),
            }
        }
        "policy_latch" => {
            let id = match args.get("id").and_then(|v| v.as_str()) {
                Some(id) => id,
                None => return Err("Missing required argument: id".to_string()),
            };
            let kind = args.get("kind").and_then(|v| v.as_str()).unwrap_or("rule");
            let namespace = args.get("namespace").and_then(|v| v.as_str()).unwrap_or("");
            let author = args
                .get("author")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let action = args
                .get("action")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let min_trust = args.get("minTrust").and_then(|v| v.as_f64());
            let context = args.get("context").cloned();
            let is_compact = args
                .get("compact")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            let input = medha::core::policy_latch::PolicyLatchInput {
                key: EntityKey::new(namespace, kind, id),
                context,
                author,
                action,
                min_trust,
            };

            match engine.policy_latch(&input, now) {
                Ok(outcome) => {
                    if is_compact {
                        Ok(json!({
                            "allowed": outcome.allowed,
                            "latched": outcome.latched,
                            "requiresHuman": outcome.requires_human,
                            "recommendation": outcome.recommendation,
                            "reason": outcome.reason,
                            "trust": outcome.trust,
                            "status": outcome.status,
                            "explanation": outcome.explanation,
                        }))
                    } else {
                        Ok(json!(outcome))
                    }
                }
                Err(e) => Err(e.to_string()),
            }
        }
        other => Err(format!("Unknown tool: {}", other)),
    }
}

/// An optional array of strings from tool arguments (`ids`, gh-23).
fn string_list(value: Option<&Value>) -> Option<Vec<String>> {
    value.and_then(|v| v.as_array()).map(|items| {
        items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect()
    })
}
