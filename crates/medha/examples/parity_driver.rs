//! Drives the Rust engine for the cross-engine parity test (`medha/src/__tests__/rust-parity.test.ts`).
//!
//! Reads one JSON request on stdin and writes one JSON response on stdout:
//!
//! - `scripts`: operation scripts (record, guard, override, retract, propose, define) run against a fresh
//!   in-memory engine. Each returns the per-op outcome, the episode log as this engine stores it,
//!   the folded states and the hints at `now`.
//! - `logs`: episode logs written by another engine, as raw stored JSON. Each episode is parsed on
//!   its own, so the response says exactly which ones this engine cannot read; the parsed ones are
//!   folded and returned with their hints at `now`.
//! - `merges`: pairs of entity-state lists, as the other engine folded them. Each pair is merged
//!   with `merge_entity_states(local, incoming)` and the merged states are returned.
//!
//! It is a test fixture, not a supported interface: the shapes follow what the test needs.

use std::io::{self, Read, Write};

use medha::core::types::{Anchor, EntityKey, LifecycleStatus};
use medha::store::{EntityState, Episode, StorePort, StoreRegistries};
use medha::{GuardInput, MedhaEngine, RecordInput};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
struct Request {
    #[serde(default)]
    scripts: Vec<Script>,
    #[serde(default)]
    logs: Vec<Log>,
    #[serde(default)]
    merges: Vec<Merge>,
}

#[derive(Deserialize)]
struct Merge {
    local: Vec<EntityState>,
    incoming: Vec<EntityState>,
}

#[derive(Deserialize)]
struct Script {
    ops: Vec<Op>,
    now: i64,
    #[serde(default)]
    registries: Option<StoreRegistries>,
}

#[derive(Deserialize)]
struct Log {
    episodes: Vec<Value>,
    now: i64,
    #[serde(default)]
    registries: Option<StoreRegistries>,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Op {
    Record {
        key: EntityKey,
        signal: String,
        at: i64,
        #[serde(default)]
        ensure: bool,
        #[serde(default)]
        author: Option<String>,
        #[serde(default)]
        anchor: Option<Anchor>,
        #[serde(default)]
        note: Option<String>,
        #[serde(default, alias = "caseId")]
        case_id: Option<String>,
    },
    Guard {
        key: EntityKey,
        ok: bool,
        #[serde(default)]
        kind: Option<String>,
        #[serde(default)]
        note: Option<String>,
        at: i64,
    },
    Override {
        key: EntityKey,
        action: String,
        reason: String,
        at: i64,
    },
    Retract {
        seq: u64,
        reason: String,
        at: i64,
    },
    Propose {
        key: EntityKey,
        provenance: String,
        #[serde(default)]
        theta0: Option<f64>,
        at: i64,
    },
    Define {
        key: EntityKey,
        title: String,
        rationale: String,
        #[serde(default)]
        tags: Option<Vec<String>>,
        at: i64,
    },
    Decision {
        key: EntityKey,
        #[serde(alias = "caseId")]
        case_id: String,
        #[serde(default, alias = "parentId")]
        parent_id: Option<String>,
        condition: String,
        decision: String,
        at: i64,
    },
    Compact {
        at: i64,
    },
    Sweep {
        #[serde(default)]
        prune: bool,
        #[serde(default)]
        older_than: Option<f64>,
        at: i64,
    },
}

type Engine = MedhaEngine<medha::store::MemoryStore>;

fn run_op(engine: &mut Engine, op: Op) -> Result<(), String> {
    let outcome = match op {
        Op::Record {
            key,
            signal,
            at,
            ensure,
            author,
            anchor,
            note,
            case_id,
        } => engine
            .record(RecordInput {
                key,
                signal,
                at,
                ensure,
                author,
                anchors: anchor.map(|a| vec![a]),
                run_ref: None,
                note,
                case_id,
            })
            .map(|_| ()),
        Op::Guard {
            key,
            ok,
            kind,
            note,
            at,
        } => engine
            .guard(GuardInput {
                key,
                ok,
                kind,
                at,
                author: None,
                note,
            })
            .map(|_| ()),
        Op::Override {
            key,
            action,
            reason,
            at,
        } => {
            let status = match action.as_str() {
                "retire" => LifecycleStatus::Retired,
                "quarantine" => LifecycleStatus::Quarantined,
                "restore" => LifecycleStatus::Probation,
                other => return Err(format!("unknown override action '{other}'")),
            };
            engine
                .override_status(&key, status, &reason, at)
                .map(|_| ())
        }
        Op::Retract { seq, reason, at } => engine.retract(seq, &reason, at).map(|_| ()),
        Op::Propose {
            key,
            provenance,
            theta0,
            at,
        } => engine
            .propose(&key, &provenance, theta0, None, at)
            .map(|_| ()),
        Op::Define {
            key,
            title,
            rationale,
            tags,
            at,
        } => engine
            .define(&key, &title, &rationale, tags, at)
            .map(|_| ()),
        Op::Decision {
            key,
            case_id,
            parent_id,
            condition,
            decision,
            at,
        } => {
            let dec = match decision.as_str() {
                "ignore" => medha::core::decision::Decision::Ignore,
                _ => medha::core::decision::Decision::Apply,
            };
            engine
                .decision(&key, &case_id, parent_id, &condition, dec, at)
                .map(|_| ())
        }
        Op::Compact { at } => engine.compact(at).map(|_| ()),
        Op::Sweep { prune, older_than, at } => engine
            .sweep(
                medha::SweepOptions {
                    prune_retired: prune,
                    max_age_days: older_than,
                },
                at,
            )
            .map(|_| ()),
    };
    outcome.map_err(|e| e.to_string())
}

fn snapshot(engine: &Engine, now: i64) -> Result<(Value, Value, Value), String> {
    let log = engine
        .store()
        .episodes(None, None)
        .map_err(|e| e.to_string())?;
    let states = engine.list().map_err(|e| e.to_string())?;
    let keys: Vec<EntityKey> = states.iter().map(|s| s.key.clone()).collect();
    let hints = engine.hints(&keys, now).map_err(|e| e.to_string())?;
    Ok((json!(log), json!(states), json!(hints)))
}

fn run_script(script: Script) -> Value {
    let mut engine = match Engine::open_in_memory() {
        Ok(engine) => engine,
        Err(e) => return json!({ "fatal": e.to_string() }),
    };
    if let Some(reg) = &script.registries {
        engine.use_registries(reg);
    }
    let results: Vec<Value> = script
        .ops
        .into_iter()
        .map(|op| match run_op(&mut engine, op) {
            Ok(()) => json!("ok"),
            Err(e) => json!(format!("error: {e}")),
        })
        .collect();
    match snapshot(&engine, script.now) {
        Ok((log, states, hints)) => {
            json!({ "results": results, "log": log, "states": states, "hints": hints })
        }
        Err(e) => json!({ "fatal": e }),
    }
}

fn read_log(log: Log) -> Value {
    let mut parsed: Vec<Episode> = Vec::new();
    let mut errors: Vec<Value> = Vec::new();
    for (index, raw) in log.episodes.into_iter().enumerate() {
        match serde_json::from_value::<Episode>(raw) {
            Ok(episode) => parsed.push(episode),
            Err(e) => errors.push(json!({ "index": index, "error": e.to_string() })),
        }
    }
    let mut engine = match Engine::open_in_memory() {
        Ok(engine) => engine,
        Err(e) => return json!({ "fatal": e.to_string() }),
    };
    if let Some(reg) = &log.registries {
        engine.use_registries(reg);
    }
    if let Err(e) = engine.store_mut().replace_log(&parsed) {
        return json!({ "fatal": e.to_string(), "errors": errors });
    }
    match snapshot(&engine, log.now) {
        Ok((reserialized, states, hints)) => json!({
            "errors": errors,
            "reserialized": reserialized,
            "states": states,
            "hints": hints,
        }),
        Err(e) => json!({ "fatal": e, "errors": errors }),
    }
}

/// One state merge, as `medha sync` runs it.
fn run_merge(merge: Merge) -> Value {
    match medha::sync::merge_entity_states(&merge.local, &merge.incoming) {
        Ok(states) => json!({ "states": states }),
        Err(e) => json!({ "fatal": e.to_string() }),
    }
}

fn main() {
    let mut input = String::new();
    if let Err(e) = io::stdin().read_to_string(&mut input) {
        eprintln!("parity_driver: cannot read stdin: {e}");
        std::process::exit(2);
    }
    let request: Request = match serde_json::from_str(&input) {
        Ok(request) => request,
        Err(e) => {
            eprintln!("parity_driver: bad request: {e}");
            std::process::exit(2);
        }
    };
    let response = json!({
        "scripts": request.scripts.into_iter().map(run_script).collect::<Vec<_>>(),
        "logs": request.logs.into_iter().map(read_log).collect::<Vec<_>>(),
        "merges": request.merges.into_iter().map(run_merge).collect::<Vec<_>>(),
    });
    let stdout = io::stdout();
    let mut out = stdout.lock();
    if serde_json::to_writer(&mut out, &response).is_err() || writeln!(out).is_err() {
        std::process::exit(2);
    }
}
