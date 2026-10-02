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
                                "namespace": { "type": "string" }
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
                        "description": "Pack active and probation entities into evidential context window within token budget.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "budget": { "type": "integer" },
                                "kind": { "type": "string" },
                                "namespace": { "type": "string" },
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
                    }
                ]
            }
        })),
        "tools/call" => {
            let params = req.params.unwrap_or(json!({}));
            let tool_name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));

            let result_val = run_tool(engine, tool_name, &args, now);
            match result_val {
                Ok(content_json) => Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "content": [
                            {
                                "type": "text",
                                "text": serde_json::to_string_pretty(&content_json).unwrap_or_default()
                            }
                        ]
                    }
                })),
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

fn run_tool<S: StorePort>(
    engine: &mut MedhaEngine<S>,
    tool_name: &str,
    args: &Value,
    now: i64,
) -> Result<Value, String> {
    match tool_name {
        "hints" => {
            let keys_val = args.get("keys").and_then(|v| v.as_array());
            if let Some(keys_arr) = keys_val {
                let mut entity_keys = Vec::new();
                for item in keys_arr {
                    let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    let kind = item.get("kind").and_then(|v| v.as_str()).unwrap_or("rule");
                    let ns = item.get("namespace").and_then(|v| v.as_str()).unwrap_or("");
                    entity_keys.push(EntityKey::new(ns, kind, id));
                }
                match engine.hints(&entity_keys, now) {
                    Ok(hints) => Ok(json!(hints)),
                    Err(e) => Err(e.to_string()),
                }
            } else {
                Err("Missing 'keys' parameter".to_string())
            }
        }
        "list_entities" => match engine.list() {
            Ok(states) => {
                let mut hints = Vec::new();
                for s in states {
                    if let Ok(h) = engine.hint(&s.key, now) {
                        hints.push(h);
                    }
                }
                Ok(json!({ "items": hints }))
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

            let input = RecordInput {
                key: EntityKey::new(ns, kind, id),
                signal: signal.to_string(),
                at: now,
                author,
                anchors: None,
                run_ref: None,
                note,
                case_id: None,
            };

            match engine.record(input) {
                Ok(res) => Ok(json!(res)),
                Err(e) => Err(e.to_string()),
            }
        }
        "report_guard" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let kind = args.get("kind").and_then(|v| v.as_str()).unwrap_or("rule");
            let ns = args.get("namespace").and_then(|v| v.as_str()).unwrap_or("");
            let ok = args.get("ok").and_then(|v| v.as_bool()).unwrap_or(true);
            let guard_kind = args
                .get("guard")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let note = args
                .get("note")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let input = GuardInput {
                key: EntityKey::new(ns, kind, id),
                ok,
                kind: guard_kind,
                at: now,
                author: None,
                note,
            };

            match engine.guard(input) {
                Ok(res) => Ok(json!(res)),
                Err(e) => Err(e.to_string()),
            }
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
            match engine.retract(seq, reason, now) {
                Ok(res) => Ok(json!({ "retractedSeq": seq, "episode": res.episode })),
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
        other => Err(format!("Unknown tool: {}", other)),
    }
}
