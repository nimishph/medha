//! The engine handle the SDK (`@cntxt-labs/medha`) runs on (ADR-0002, plan/sdk-on-rust-engine).
//!
//! One `NapiEngine` holds one `MedhaEngine<HomeStore>`, opened the way the CLI opens a home
//! (`medha_cli::open_home`), so the SDK and the CLI share the store, signing and namespace-scope
//! code as well as the engine. Every operation goes through `call(op, args)`, which runs on libuv's
//! worker pool and resolves to an envelope:
//!
//! - `{ ok: true, value }`: `value` in the TypeScript engine's shape (`EvidentialHint`,
//!   `EntityDetail`, `RecordOutcome`, …), built by the CLI's `ts_view`;
//! - `{ ok: false, error }`: the TypeScript `MedhaError` shape (`name`, `code`, `subsystem`,
//!   `message`, `context`, `hint`), as the CLI's `failure::classify` builds it.
//!
//! Errors travel as data, not as thrown JS errors, so the SDK can rebuild the exact error class.

use std::error::Error;
use std::sync::{Arc, Mutex};

use medha::config::MedhaConfig;
use medha::core::types::{Anchor, EntityKey};
use medha::store::{EntityDefinition, StoreRegistries};
use medha::{GuardInput, MedhaEngine, RecordInput};
use medha_cli::failure::{self, Failure};
use medha_cli::home_store::HomeStore;
use medha_cli::ts_view;
use napi::{Env, JsUnknown, Task};
use napi_derive::napi;
use serde::Deserialize;
use serde_json::{json, Value};

type Engine = MedhaEngine<HomeStore>;
type Res<T> = Result<T, Box<dyn Error>>;

#[derive(Default)]
struct Slot {
    engine: Option<Engine>,
}

/// A handle on one engine. Starts closed: `call("open", …)` or `call("memory", …)` opens it.
#[napi]
pub struct NapiEngine {
    slot: Arc<Mutex<Slot>>,
}

impl Default for NapiEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
impl NapiEngine {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            slot: Arc::new(Mutex::new(Slot::default())),
        }
    }

    /// Run one operation off the JS thread. Resolves to `{ ok, value }` or `{ ok, error }`.
    #[napi(
        ts_return_type = "Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }>"
    )]
    pub fn call(&self, op: String, args: Option<Value>) -> napi::bindgen_prelude::AsyncTask<Call> {
        napi::bindgen_prelude::AsyncTask::new(Call {
            slot: Arc::clone(&self.slot),
            op,
            args: args.unwrap_or(Value::Null),
        })
    }
}

pub struct Call {
    slot: Arc<Mutex<Slot>>,
    op: String,
    args: Value,
}

impl Task for Call {
    type Output = Value;
    type JsValue = JsUnknown;

    fn compute(&mut self) -> napi::Result<Value> {
        let mut slot = match self.slot.lock() {
            Ok(guard) => guard,
            // A panic in an earlier call poisoned the lock; the engine state is still usable.
            Err(poisoned) => poisoned.into_inner(),
        };
        Ok(envelope(dispatch(&mut slot, &self.op, &self.args)))
    }

    fn resolve(&mut self, env: Env, output: Value) -> napi::Result<JsUnknown> {
        env.to_js_value(&output)
    }
}

fn envelope(result: Res<Value>) -> Value {
    match result {
        Ok(value) => json!({ "ok": true, "value": value }),
        Err(err) => json!({ "ok": false, "error": failure::classify(err.as_ref()).to_json() }),
    }
}

fn not_open() -> Box<dyn Error> {
    Box::new(Failure::new(
        "EngineClosedError",
        "SDK_ENGINE_CLOSED",
        "sdk",
        "the native engine is not open",
    ))
}

fn arg<T: for<'de> Deserialize<'de>>(args: &Value, name: &str) -> Res<T> {
    serde_json::from_value(args.get(name).cloned().unwrap_or(Value::Null)).map_err(|e| {
        Box::new(Failure::invalid(name, "a value of the expected shape", e)) as Box<dyn Error>
    })
}

fn opt<T: for<'de> Deserialize<'de>>(args: &Value, name: &str) -> Res<Option<T>> {
    match args.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => arg(args, name).map(Some),
    }
}

fn now_of(args: &Value) -> Res<i64> {
    match args.get("now").and_then(Value::as_f64) {
        Some(v) if v.is_finite() => Ok(v as i64),
        _ => Err(Box::new(Failure::invalid(
            "context.now",
            "a finite epoch timestamp",
            args.get("now").cloned().unwrap_or(Value::Null),
        ))),
    }
}

fn dispatch(slot: &mut Slot, op: &str, args: &Value) -> Res<Value> {
    match op {
        "open" => {
            let dir: Option<String> = opt(args, "dir")?;
            let home: Option<String> = opt(args, "home")?;
            let scoped: Option<bool> = opt(args, "scoped")?;
            let (engine, home_dir, config) =
                medha_cli::open_home(dir.as_deref(), home.as_deref(), scoped.unwrap_or(true))?;
            let home = home_dir.display().to_string();
            slot.engine = Some(engine);
            Ok(json!({ "home": home, "registries": config.registries }))
        }
        "memory" => {
            let registries: StoreRegistries = opt(args, "registries")?.unwrap_or_default();
            let config = MedhaConfig {
                registries: registries.clone(),
                ..MedhaConfig::default()
            };
            let mut engine = MedhaEngine::open_with(HomeStore::memory(registries.clone()), config)?;
            engine.use_registries(&registries);
            slot.engine = Some(engine);
            Ok(json!({ "registries": registries }))
        }
        "close" => {
            slot.engine = None;
            Ok(Value::Null)
        }
        _ => {
            let engine = slot.engine.as_mut().ok_or_else(not_open)?;
            engine_op(engine, op, args)
        }
    }
}

fn require_kind(engine: &Engine, key: &EntityKey) -> Res<()> {
    Ok(engine.require_kind(key)?)
}

/// The TypeScript `entityKeyString`: NUL-separated, the order `list` breaks ties in.
fn key_string(key: &EntityKey) -> String {
    format!("{}\u{0}{}\u{0}{}", key.namespace, key.kind, key.id)
}

fn engine_op(engine: &mut Engine, op: &str, args: &Value) -> Res<Value> {
    match op {
        // Map<entityKeyString, EvidentialHint>, as an array: unknown keys are left out.
        "hints" => {
            let keys: Vec<EntityKey> = arg(args, "keys")?;
            let now = now_of(args)?;
            let mut out = Vec::new();
            let mut seen = std::collections::HashSet::new();
            for key in &keys {
                require_kind(engine, key)?;
                // A Map in TypeScript: a repeated key keeps its first place.
                if engine.get(key)?.is_some() && seen.insert(key_string(key)) {
                    out.push(ts_view::hint(engine, key, now)?);
                }
            }
            Ok(Value::Array(out))
        }
        // Every hint the filter keeps, ordered by trust desc then key; the SDK paginates.
        "list" => {
            #[derive(Deserialize, Default)]
            struct Filter {
                kind: Option<String>,
                status: Option<String>,
                namespace: Option<String>,
                drifting: Option<bool>,
                ids: Option<Vec<String>>,
            }
            let filter: Filter = opt(args, "filter")?.unwrap_or_default();
            let now = now_of(args)?;
            if let Some(kind) = &filter.kind {
                require_kind(engine, &EntityKey::new("", kind, "x"))?;
            }
            let mut items: Vec<(String, f64, Value)> = Vec::new();
            for state in engine.list()? {
                let hint = ts_view::hint(engine, &state.key, now)?;
                let keep = filter.kind.as_ref().is_none_or(|k| &state.key.kind == k)
                    && filter
                        .status
                        .as_ref()
                        .is_none_or(|s| hint["status"].as_str() == Some(s.as_str()))
                    && filter
                        .namespace
                        .as_ref()
                        .is_none_or(|n| &state.key.namespace == n)
                    && filter
                        .drifting
                        .is_none_or(|d| hint["temporal"]["isDrifting"].as_bool() == Some(d))
                    && filter
                        .ids
                        .as_ref()
                        .is_none_or(|ids| ids.contains(&state.key.id));
                if keep {
                    let trust = hint["trustScore"].as_f64().unwrap_or(0.0);
                    items.push((key_string(&state.key), trust, hint));
                }
            }
            items.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            Ok(Value::Array(items.into_iter().map(|(_, _, h)| h).collect()))
        }
        // EntityDetail.
        "show" => {
            let key: EntityKey = arg(args, "key")?;
            let now = now_of(args)?;
            let recent: Option<f64> = opt(args, "recent")?;
            let recent = match recent {
                None => 10,
                Some(r) if r.fract() == 0.0 && (1.0..=9.007_199_254_740_991e15).contains(&r) => {
                    r as usize
                }
                Some(r) => {
                    return Err(Box::new(Failure::invalid(
                        "options.recent",
                        "a positive integer",
                        r,
                    )))
                }
            };
            require_kind(engine, &key)?;
            let report = ts_view::show_report(engine, "", &key, now, recent)?;
            Ok(report["detail"].clone())
        }
        // RecordOutcome: { hint, state, updater? }.
        "record" => {
            let key: EntityKey = arg(args, "key")?;
            let signal: String = arg(args, "signal")?;
            let now = now_of(args)?;
            let anchor: Option<Anchor> = opt(args, "anchor")?;
            let updater: Option<String> = opt(args, "updater")?;
            let res = engine.record_with_updater(
                RecordInput {
                    key: key.clone(),
                    signal,
                    at: now,
                    ensure: opt(args, "ensure")?.unwrap_or(false),
                    author: opt(args, "author")?,
                    anchors: anchor.map(|a| vec![a]),
                    run_ref: opt(args, "runRef")?,
                    note: opt(args, "note")?,
                    case_id: opt(args, "caseId")?,
                },
                updater.as_deref().filter(|u| !u.is_empty()),
            )?;
            let hint = ts_view::hint(engine, &key, now)?;
            // `state` is left out, not null, when the signal changed nothing (TypeScript `undefined`).
            let mut out = json!({ "hint": hint });
            if let Some(state) = &res.state {
                out["state"] = serde_json::to_value(state)?;
            }
            let episode = serde_json::to_value(&res.episode)?;
            if res.state.is_some() {
                if let Some(name) = episode.get("updater").and_then(Value::as_str) {
                    out["updater"] = json!({ "name": name });
                }
            }
            Ok(out)
        }
        // EvidentialHint.
        "reportGuard" => {
            let key: EntityKey = arg(args, "key")?;
            let now = now_of(args)?;
            let at: Option<f64> = opt(args, "at")?;
            let at = at.map(|a| a as i64).unwrap_or(now);
            engine.guard(GuardInput {
                key: key.clone(),
                ok: arg(args, "ok")?,
                kind: opt(args, "kind")?,
                at,
                author: opt(args, "author")?,
                note: opt(args, "note")?,
            })?;
            Ok(ts_view::hint(engine, &key, now)?)
        }
        // { episode, definition }.
        "define" => {
            let key: EntityKey = arg(args, "key")?;
            let definition: EntityDefinition = arg(args, "definition")?;
            let now = now_of(args)?;
            let res = engine.define_entity(&key, definition.clone(), now)?;
            Ok(json!({ "episode": res.episode, "definition": definition }))
        }
        other => Err(Box::new(
            Failure::new(
                "UnsupportedOperationError",
                "SDK_UNSUPPORTED_OPERATION",
                "sdk",
                format!("the native engine has no operation '{other}'"),
            )
            .with_context(json!({ "op": other })),
        )),
    }
}
