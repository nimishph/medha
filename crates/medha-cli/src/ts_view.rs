//! The TypeScript engine's read shapes, built from the Rust engine's data.
//!
//! The Rust engine's `TrustHint` (trust, trials, successes, breakdown) is a different shape from the
//! TypeScript `EvidentialHint` that the TypeScript CLI prints and serializes. Every CLI command that
//! shows a hint goes through here, so text output and `--json` both match the reference CLI
//! (`medha-core/src/hint.ts` `buildHint`/`evaluateGates`, `medha/src/engine.ts` `show`).

use medha::core::thresholds::{DRIFT_THRESHOLD, MIN_SAMPLES_FOR_DRIFT};
use medha::core::types::{EntityKey, Thresholds, TrustHint};
use medha::store::{Episode, EpisodePayload, StorePort};
use medha::{MedhaEngine, MedhaError};
use serde_json::{json, Value};

use crate::render::status_name;

fn round6(v: f64) -> f64 {
    (v * 1e6).round() / 1e6
}

/// A JSON number the way JavaScript prints it: integral values without a fraction.
pub fn num(v: f64) -> Value {
    if v.is_finite() && v.fract() == 0.0 && v.abs() < 9.0e15 {
        json!(v as i64)
    } else {
        json!(v)
    }
}

pub fn key_json(key: &EntityKey) -> Value {
    json!({ "namespace": key.namespace, "kind": key.kind, "id": key.id })
}

/// `kind/id`, or `namespace/kind/id` (the TypeScript `keyLabel`).
pub fn key_label(key: &EntityKey) -> String {
    if key.namespace.is_empty() {
        format!("{}/{}", key.kind, key.id)
    } else {
        format!("{}/{}/{}", key.namespace, key.kind, key.id)
    }
}

/// The ISO-8601 time JavaScript's `Date#toISOString` prints.
pub fn iso(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Civil-from-days (Howard Hinnant), proleptic Gregorian.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z")
}

/// Fixed three decimals, as the TypeScript `fixed` helper (non-finite reads 0.000).
pub fn fixed(v: f64) -> String {
    if v.is_finite() {
        format!("{v:.3}")
    } else {
        "0.000".to_string()
    }
}

/// The per-kind thresholds in force (kind spec, else the canonical defaults).
pub fn thresholds_for<S: StorePort>(engine: &MedhaEngine<S>, kind: &str) -> Thresholds {
    engine
        .store()
        .registries()
        .kind_spec(kind)
        .map(|ks| ks.thresholds.clone())
        .unwrap_or_default()
}

struct Inputs {
    n: f64,
    k: f64,
    mu: f64,
    theta0: f64,
    guard_passed: bool,
    last_note: Option<String>,
}

fn inputs<S: StorePort>(
    engine: &MedhaEngine<S>,
    key: &EntityKey,
) -> Result<(bool, Inputs), MedhaError> {
    Ok(match engine.get(key)? {
        Some(state) => (
            true,
            Inputs {
                n: state.evidence.n,
                k: state.evidence.k,
                mu: state.ema.mu,
                theta0: state.ema.theta0,
                guard_passed: state.guard.last_ok == Some(true)
                    && !state.guard.kind.is_empty()
                    && state.guard.kind != "none",
                last_note: state.last_note.clone(),
            },
        ),
        None => (
            false,
            Inputs {
                n: 0.0,
                k: 0.0,
                mu: medha::core::thresholds::DEFAULT_THETA0,
                theta0: medha::core::thresholds::DEFAULT_THETA0,
                guard_passed: false,
                last_note: None,
            },
        ),
    })
}

fn gate(name: &str, threshold: f64, value: f64, conditions: Vec<Value>) -> Value {
    let met = conditions.iter().all(|c| c["met"].as_bool() == Some(true));
    json!({ "name": name, "met": met, "threshold": num(threshold), "value": num(value), "conditions": conditions })
}

fn condition(name: &str, met: bool, actual: Value, expected: Value) -> Value {
    json!({ "name": name, "met": met, "actual": actual, "expected": expected })
}

fn gates_from(i: &Inputs, trust: f64, t: &Thresholds) -> Vec<Value> {
    let delta = round6((i.mu - i.theta0).abs());
    vec![
        gate(
            "trusted",
            t.trusted,
            trust,
            vec![
                condition("trust", trust >= t.trusted, num(trust), num(t.trusted)),
                condition(
                    "uses",
                    i.n >= t.min_uses_for_trusted as f64,
                    num(i.n),
                    json!(t.min_uses_for_trusted),
                ),
                condition("guard", i.guard_passed, json!(i.guard_passed), json!(true)),
            ],
        ),
        gate(
            "active",
            t.active,
            trust,
            vec![condition(
                "trust",
                trust >= t.active,
                num(trust),
                num(t.active),
            )],
        ),
        gate(
            "drifting",
            DRIFT_THRESHOLD,
            delta,
            vec![
                condition(
                    "samples",
                    i.n >= MIN_SAMPLES_FOR_DRIFT as f64,
                    num(i.n),
                    json!(MIN_SAMPLES_FOR_DRIFT),
                ),
                condition(
                    "drift",
                    delta >= DRIFT_THRESHOLD,
                    num(delta),
                    num(DRIFT_THRESHOLD),
                ),
            ],
        ),
    ]
}

fn hint_from(h: &TrustHint, i: &Inputs, gates: &[Value], as_of: i64) -> Value {
    let b = &h.breakdown;
    let mut v = json!({
        "key": key_json(&h.key),
        "asOf": as_of,
        "trustScore": num(round6(h.trust)),
        "components": {
            "wilson": num(round6(b.wilson_lower)),
            "guard": num(round6(b.guard_factor)),
            "recency": num(round6(b.recency)),
            "durability": num(round6(b.durability)),
            "ceiling": num(round6(b.effective_ceiling)),
        },
        "evidence": {
            "successes": num(i.k),
            "totalTrials": num(i.n),
            "lowerBound": num(round6(b.wilson_lower)),
        },
        "temporal": {
            "emaWeight": num(round6(i.mu)),
            "baselineWeight": num(round6(i.theta0)),
            "isDrifting": gates[2]["met"],
            "driftDelta": gates[2]["value"],
            "driftDirection": if i.mu <= i.theta0 { "down" } else { "up" },
        },
        "status": status_name(&h.status),
    });
    if let Some(note) = &i.last_note {
        v["lastNote"] = json!(note);
    }
    v["clearsThreshold"] = json!({ "trusted": gates[0]["met"], "active": gates[1]["met"] });
    v
}

/// The TypeScript `EvidentialHint` for one key.
pub fn hint<S: StorePort>(
    engine: &MedhaEngine<S>,
    key: &EntityKey,
    now: i64,
) -> Result<Value, MedhaError> {
    let h = engine.hint(key, now)?;
    hint_of(engine, &h, now)
}

/// The TypeScript `EvidentialHint` for a Rust hint already computed.
pub fn hint_of<S: StorePort>(
    engine: &MedhaEngine<S>,
    h: &TrustHint,
    now: i64,
) -> Result<Value, MedhaError> {
    let (_, i) = inputs(engine, &h.key)?;
    let gates = gates_from(&i, h.trust, &thresholds_for(engine, &h.key.kind));
    Ok(hint_from(h, &i, &gates, now))
}

fn episodes_of<S: StorePort>(
    engine: &MedhaEngine<S>,
    key: &EntityKey,
) -> Result<Vec<Episode>, MedhaError> {
    let repr = key.to_string_repr();
    Ok(engine
        .store()
        .episodes(None, None)?
        .into_iter()
        .filter(|e| e.key.to_string_repr() == repr)
        .collect())
}

/// Seqs of signals or guards logged before the key existed, without `ensure`: logged, no effect.
fn no_effect(episodes: &[Episode]) -> Vec<u64> {
    let mut exists = false;
    let mut out = Vec::new();
    for e in episodes {
        let v = serde_json::to_value(e).unwrap_or(Value::Null);
        let ty = v["type"].as_str().unwrap_or("");
        let ensure = v["ensure"].as_bool() == Some(true);
        match ty {
            "proposal" | "baseline" | "definition" => exists = true,
            "signal" | "guard" => {
                if exists || ensure {
                    exists = true;
                } else {
                    out.push(e.seq);
                }
            }
            _ => {}
        }
    }
    out
}

/// The TypeScript `EntityDetail` plus the CLI `ShowReport` wrapper.
pub fn show_report<S: StorePort>(
    engine: &MedhaEngine<S>,
    home: &str,
    key: &EntityKey,
    now: i64,
    recent: usize,
) -> Result<Value, MedhaError> {
    let h = engine.hint(key, now)?;
    let (known, i) = inputs(engine, key)?;
    let gates = gates_from(&i, h.trust, &thresholds_for(engine, &key.kind));
    let hint = hint_from(&h, &i, &gates, now);
    let episodes = episodes_of(engine, key)?;
    let mut recent_eps: Vec<&Episode> = episodes.iter().collect();
    recent_eps.sort_by_key(|e| std::cmp::Reverse(e.seq));
    recent_eps.truncate(recent);
    let mut provenance: Vec<String> = Vec::new();
    let mut promoted = false;
    for e in &episodes {
        if let EpisodePayload::Proposal {
            provenance: p,
            promoted: pr,
            ..
        } = &e.payload
        {
            if !provenance.contains(p) {
                provenance.push(p.clone());
            }
            promoted |= *pr == Some(true);
        }
    }
    let mut detail = json!({
        "hint": hint,
        "gates": gates,
        "known": known,
        "recentEpisodes": recent_eps,
        "noEffect": no_effect(&episodes),
    });
    if known {
        if let Some(latch) = engine.latch_of(key)? {
            detail["latch"] = serde_json::to_value(latch)?;
        }
    }
    detail["provenance"] = json!(provenance);
    detail["promoted"] = json!(promoted);
    // Non-evidential: the latest definition, and the scored decision forest.
    let definition = episodes.iter().rev().find_map(|e| match &e.payload {
        EpisodePayload::Define { definition } => serde_json::to_value(definition).ok(),
        _ => None,
    });
    if let Some(def) = &definition {
        detail["definition"] = def.clone();
    }
    let tree = decision_tree(engine, key, now)?;
    if !tree.is_empty() {
        detail["decisionTree"] = json!(tree);
    }
    let mut report = json!({ "home": home, "asOf": now, "key": key_json(key), "detail": detail });
    if let Some(def) = definition {
        report["definition"] = def;
    }
    if !tree.is_empty() {
        report["decisionTree"] = json!(tree);
    }
    Ok(report)
}

/// The entity's decision forest, each branch scored (TypeScript `ScoredDecisionCase`).
pub fn decision_tree<S: StorePort>(
    engine: &MedhaEngine<S>,
    key: &EntityKey,
    now: i64,
) -> Result<Vec<Value>, MedhaError> {
    let Some(state) = engine.get(key)? else {
        return Ok(Vec::new());
    };
    let spec = engine.store().registries().kind_spec(&key.kind).cloned();
    let thresholds = spec
        .as_ref()
        .map(|s| s.thresholds.clone())
        .unwrap_or_default();
    let recency = spec.as_ref().map(|s| s.recency.clone()).unwrap_or_default();
    let mut out = Vec::new();
    for kase in &state.decision_tree {
        let scored = medha::core::decision::score_decision_case(kase, now, &thresholds, &recency)?;
        let mut v = json!({
            "id": kase.id,
            "condition": kase.condition,
            "decision": kase.decision,
            "evidence": {
                "k": num(kase.evidence.k),
                "n": num(kase.evidence.n),
                "contextRejects": kase.evidence.context_rejects,
            },
            "ema": {
                "mu": num(round6(kase.ema.mu)),
                "theta0": num(kase.ema.theta0),
                "updatedAt": kase.ema.updated_at,
            },
            "status": status_name(&scored.status),
            "trust": num(round6(scored.trust)),
        });
        if let Some(p) = &kase.parent_id {
            v["parentId"] = json!(p);
        }
        out.push(v);
    }
    Ok(out)
}
