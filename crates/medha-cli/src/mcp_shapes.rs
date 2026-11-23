//! MCP tool results in the TypeScript server's shapes (`cli/src/mcp.ts`, `cli/src/shape.ts`).
//!
//! `ts_tool` answers the tools whose result object differs from the Rust one, reusing the CLI's
//! TypeScript-shaped reports; `ts_hints` then rewrites any Rust `TrustHint` left in a result into
//! the TypeScript `EvidentialHint`, so every tool reports hints the same way.

use medha::core::types::{EntityKey, TrustHint};
use medha::store::{MemoryStore, StorePort};
use medha::{MedhaEngine, ProposeInput, RecordInput};
use serde_json::{json, Value};

use crate::ts_view;

fn key_of(args: &Value) -> EntityKey {
    EntityKey::new(
        args.get("namespace").and_then(|v| v.as_str()).unwrap_or(""),
        args.get("kind").and_then(|v| v.as_str()).unwrap_or("rule"),
        args.get("id").and_then(|v| v.as_str()).unwrap_or(""),
    )
}

fn str_arg(args: &Value, name: &str) -> Option<String> {
    args.get(name).and_then(|v| v.as_str()).map(String::from)
}

fn strings(args: &Value, name: &str) -> Option<Vec<String>> {
    args.get(name).and_then(|v| v.as_array()).map(|a| {
        a.iter()
            .filter_map(|x| x.as_str().map(String::from))
            .collect()
    })
}

/// TypeScript `compactHint`: one line per entity.
pub fn compact_hint(h: &Value) -> Value {
    let key: EntityKey =
        serde_json::from_value(h["key"].clone()).unwrap_or_else(|_| EntityKey::new("", "", ""));
    let mut v = json!({
        "key": ts_view::key_label(&key),
        "trust": h["trustScore"],
        "status": h["status"],
        "successes": h["evidence"]["successes"],
        "trials": h["evidence"]["totalTrials"],
        "drifting": h["temporal"]["isDrifting"],
    });
    if let Some(n) = h.get("lastNote") {
        v["lastNote"] = n.clone();
    }
    v
}

fn compact(args: &Value) -> bool {
    args.get("compact").and_then(|v| v.as_bool()) == Some(true)
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// The hint a signal would produce, from a throwaway in-memory replay of the log.
fn simulated<S: StorePort>(
    engine: &MedhaEngine<S>,
    key: &EntityKey,
    signal: &str,
    now: i64,
) -> Result<Value, String> {
    let mut scratch: MedhaEngine<MemoryStore> = MedhaEngine::open_in_memory().map_err(err)?;
    let registries = engine.store().registries().clone();
    scratch.use_registries(&registries);
    let log = engine.store().episodes(None, None).map_err(err)?;
    scratch.store_mut().replace_log(&log).map_err(err)?;
    scratch
        .record(RecordInput {
            key: key.clone(),
            signal: signal.to_string(),
            at: now,
            ensure: true,
            author: None,
            anchors: None,
            run_ref: None,
            note: None,
            case_id: None,
        })
        .map_err(err)?;
    ts_view::hint(&scratch, key, now).map_err(err)
}

/// Answer the tools whose TypeScript result differs from the Rust one; `None` leaves the tool to
/// the Rust handler.
pub fn ts_tool<S: StorePort>(
    engine: &mut MedhaEngine<S>,
    name: &str,
    args: &Value,
    now: i64,
) -> Option<Result<Value, String>> {
    let result = match name {
        "list_entities" => (|| {
            let report = crate::read::list_report(
                engine,
                "",
                now,
                &crate::read::ListOptions {
                    kind: args.get("kind").and_then(|v| v.as_str()),
                    status: args.get("status").and_then(|v| v.as_str()),
                    namespace: args.get("namespace").and_then(|v| v.as_str()),
                    drifting: (args.get("drifting").and_then(|v| v.as_bool()) == Some(true))
                        .then_some(true),
                    ids: strings(args, "ids"),
                    limit: args
                        .get("limit")
                        .and_then(|v| v.as_u64())
                        .map(|l| l as usize),
                    cursor: args.get("cursor").and_then(|v| v.as_str()),
                },
            )
            .map_err(err)?;
            let mut page = report["page"].clone();
            if compact(args) {
                let items: Vec<Value> = page["items"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .map(compact_hint)
                    .collect();
                page["items"] = json!(items);
            }
            Ok(page)
        })(),
        "show_entity" => (|| {
            let recent = args
                .get("recent")
                .and_then(|v| v.as_u64())
                .map(|r| r as usize)
                .unwrap_or(10);
            let report =
                ts_view::show_report(engine, "", &key_of(args), now, recent).map_err(err)?;
            Ok(report["detail"].clone())
        })(),
        "hints" => (|| {
            let keys: Vec<EntityKey> = args
                .get("keys")
                .and_then(|v| v.as_array())
                .ok_or("Missing 'keys' parameter")?
                .iter()
                .map(key_of)
                .collect();
            let mut hints = Vec::new();
            let mut unknown = Vec::new();
            for k in &keys {
                if engine.get(k).map_err(err)?.is_some() {
                    let h = ts_view::hint(engine, k, now).map_err(err)?;
                    hints.push(if compact(args) { compact_hint(&h) } else { h });
                } else {
                    unknown.push(ts_view::key_json(k));
                }
            }
            Ok(json!({ "hints": hints, "unknown": unknown }))
        })(),
        "record_signal" => (|| {
            let key = key_of(args);
            let updater = str_arg(args, "updater");
            if let Some(u) = updater.as_deref() {
                if !medha::is_builtin_updater(u) {
                    return Err(format!("no updater named '{u}'"));
                }
            }
            let res = engine
                .record_with_updater(
                    RecordInput {
                        key: key.clone(),
                        signal: str_arg(args, "signal").unwrap_or_else(|| "APPLY".to_string()),
                        at: crate::write::parse_timestamp(
                            args.get("at").and_then(|v| v.as_str()),
                            now,
                        )
                        .map_err(err)?,
                        ensure: args.get("ensure").and_then(|v| v.as_bool()) == Some(true),
                        author: crate::write::resolve_author(
                            args.get("author").and_then(|v| v.as_str()),
                        ),
                        anchors: None,
                        run_ref: None,
                        note: str_arg(args, "note"),
                        case_id: str_arg(args, "caseId"),
                    },
                    updater.as_deref(),
                )
                .map_err(err)?;
            let recorded = res.state.is_some();
            let h = ts_view::hint(engine, &key, now).map_err(err)?;
            let mut v = json!({ "recorded": recorded });
            if !recorded {
                v["note"] = json!("entity is unknown and `ensure` was not set: nothing was recorded; the hint is a probation prior. Pass ensure: true to create it.");
            }
            v["hint"] = if compact(args) { compact_hint(&h) } else { h };
            if recorded {
                let used = res.episode.payload.clone();
                if let medha::store::EpisodePayload::Signal {
                    updater: Some(u), ..
                } = used
                {
                    v["updater"] = json!({ "name": u });
                }
            }
            if let Some(c) = str_arg(args, "caseId") {
                v["caseId"] = json!(c);
            }
            Ok(v)
        })(),
        "propose" => (|| {
            let key = key_of(args);
            let source = str_arg(args, "source")
                .or_else(|| str_arg(args, "provenance"))
                .ok_or("Invalid source: expected a non-empty proposal source")?;
            let at = crate::write::parse_timestamp(args.get("at").and_then(|v| v.as_str()), now)
                .map_err(err)?;
            let outcome = engine
                .propose_with(ProposeInput {
                    key: key.clone(),
                    provenance: source,
                    theta0: args.get("theta0").and_then(|v| v.as_f64()),
                    description: str_arg(args, "text").or_else(|| str_arg(args, "description")),
                    evidence_refs: strings(args, "evidenceRefs"),
                    author: crate::write::resolve_author(
                        args.get("author").and_then(|v| v.as_str()),
                    ),
                    note: str_arg(args, "note"),
                    anchor: args
                        .get("anchor")
                        .and_then(|a| serde_json::from_value(a.clone()).ok()),
                    at,
                })
                .map_err(err)?;
            let h = ts_view::hint(engine, &key, at).map_err(err)?;
            Ok(json!({
                "hint": if compact(args) { compact_hint(&h) } else { h },
                "promoted": outcome.promoted,
                "promotionReason": outcome.promotion_reason,
                "provenances": outcome.provenances,
                "episode": outcome.appended.episode,
            }))
        })(),
        "simulate" => (|| {
            let key = key_of(args);
            let signal = str_arg(args, "signal").ok_or("Invalid signal: expected a signal name")?;
            let before = ts_view::hint(engine, &key, now).map_err(err)?;
            let after = simulated(engine, &key, &signal, now)?;
            let delta = after["trustScore"].as_f64().unwrap_or(0.0)
                - before["trustScore"].as_f64().unwrap_or(0.0);
            Ok(json!({
                "key": ts_view::key_json(&key),
                "asOf": now,
                "before": before,
                "after": after,
                "deltaTrust": ts_view::num((delta * 1e6).round() / 1e6),
                "statusChanged": before["status"] != after["status"],
            }))
        })(),
        "drift" => (|| {
            let limit = args
                .get("limit")
                .and_then(|v| v.as_u64())
                .map(|l| l as usize);
            let report = crate::read::drift_report(engine, "", now, limit).map_err(err)?;
            Ok(report["report"].clone())
        })(),
        "status" => (|| {
            let preflight = crate::read::preflight_json(engine, now).map_err(err)?;
            let all = crate::read::all_hints(engine, now).map_err(err)?;
            let mut by_status = serde_json::Map::new();
            for s in crate::read::LIFECYCLE_STATUSES {
                by_status.insert(
                    s.to_string(),
                    json!(all.iter().filter(|h| h["status"] == s).count()),
                );
            }
            let drifting = all
                .iter()
                .filter(|h| h["temporal"]["isDrifting"] == true)
                .count();
            Ok(json!({
                "preflight": preflight,
                "byStatus": by_status,
                "driftingCount": drifting,
                "totalEntities": all.len(),
            }))
        })(),
        "record_decision" => (|| {
            let key = key_of(args);
            let condition = str_arg(args, "condition")
                .ok_or("Invalid condition: expected a non-empty string")?;
            let decision: medha::core::decision::Decision =
                serde_json::from_value(args.get("decision").cloned().unwrap_or(Value::Null))
                    .map_err(|e| format!("Invalid decision: {e}"))?;
            let at = crate::write::parse_timestamp(args.get("at").and_then(|v| v.as_str()), now)
                .map_err(err)?;
            let (_, case_id) = engine
                .decision_with(medha::DecisionInput {
                    key: key.clone(),
                    case_id: str_arg(args, "caseId"),
                    parent_id: str_arg(args, "parentId"),
                    detach: args.get("detach").and_then(|v| v.as_bool()) == Some(true),
                    condition: condition.clone(),
                    decision: decision.clone(),
                    author: crate::write::resolve_author(
                        args.get("author").and_then(|v| v.as_str()),
                    ),
                    at,
                })
                .map_err(err)?;
            let tree = ts_view::decision_tree(engine, &key, at).map_err(err)?;
            Ok(json!({
                "caseId": case_id,
                "condition": condition,
                "decision": decision,
                "decisionTree": tree,
            }))
        })(),
        _ => return None,
    };
    Some(result)
}

fn looks_like_rust_hint(v: &Value) -> bool {
    v.get("breakdown").is_some() && v.get("trust").is_some() && v.get("key").is_some()
}

/// Rewrite every Rust `TrustHint` in a tool result into the TypeScript `EvidentialHint`.
pub fn ts_hints<S: StorePort>(engine: &MedhaEngine<S>, value: &mut Value, now: i64) {
    match value {
        Value::Object(map) => {
            for v in map.values_mut() {
                if looks_like_rust_hint(v) {
                    if let Ok(h) = serde_json::from_value::<TrustHint>(v.clone()) {
                        if let Ok(ts) = ts_view::hint_of(engine, &h, now) {
                            *v = ts;
                            continue;
                        }
                    }
                }
                ts_hints(engine, v, now);
            }
        }
        Value::Array(items) => {
            for v in items.iter_mut() {
                ts_hints(engine, v, now);
            }
        }
        _ => {}
    }
}
