//! Read commands (`list`, `status`, `drift`, `explain-threshold`) in the TypeScript CLI's shapes
//! (`cli/src/read.ts` reports, `cli/src/render.ts` text).

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use medha::core::types::EntityKey;
use medha::store::StorePort;
use medha::{MedhaEngine, MedhaError};
use serde_json::{json, Value};

use crate::failure::Failure;
use crate::ts_view::{self, fixed, key_json, key_label};

pub const LIFECYCLE_STATUSES: [&str; 5] =
    ["probation", "active", "trusted", "quarantined", "retired"];
pub const DEFAULT_RESULT_LIMIT: usize = 1000;
const LAST_SWEEP_META_KEY: &str = "sweep:lastRun";

pub fn require_status(raw: &str) -> Result<String, Failure> {
    if LIFECYCLE_STATUSES.contains(&raw) {
        Ok(raw.to_string())
    } else {
        Err(Failure::invalid(
            "--status",
            &LIFECYCLE_STATUSES.join(" | "),
            raw,
        ))
    }
}

pub fn encode_cursor(offset: usize) -> String {
    URL_SAFE_NO_PAD.encode(format!("{{\"v\":1,\"offset\":{offset}}}"))
}

pub fn decode_cursor(cursor: &str) -> Result<usize, Failure> {
    let bad = || Failure::invalid("cursor", "a cursor returned by a previous page", cursor);
    let bytes = URL_SAFE_NO_PAD
        .decode(cursor.trim_end_matches('='))
        .map_err(|_| bad())?;
    let v: Value = serde_json::from_slice(&bytes).map_err(|_| bad())?;
    if v["v"] != json!(1) {
        return Err(bad());
    }
    v["offset"].as_u64().map(|o| o as usize).ok_or_else(bad)
}

/// Every TypeScript hint in the store, sorted most trusted first, then by key.
pub fn all_hints<S: StorePort>(
    engine: &MedhaEngine<S>,
    now: i64,
) -> Result<Vec<Value>, MedhaError> {
    let mut hints = Vec::new();
    for s in engine.list()? {
        hints.push(ts_view::hint(engine, &s.key, now)?);
    }
    hints.sort_by(|a, b| {
        let ta = a["trustScore"].as_f64().unwrap_or(0.0);
        let tb = b["trustScore"].as_f64().unwrap_or(0.0);
        tb.partial_cmp(&ta)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| key_string(&a["key"]).cmp(&key_string(&b["key"])))
    });
    Ok(hints)
}

fn key_string(k: &Value) -> String {
    format!(
        "{}/{}/{}",
        k["namespace"].as_str().unwrap_or(""),
        k["kind"].as_str().unwrap_or(""),
        k["id"].as_str().unwrap_or("")
    )
}

pub struct ListOptions<'a> {
    pub kind: Option<&'a str>,
    pub status: Option<&'a str>,
    pub namespace: Option<&'a str>,
    pub drifting: Option<bool>,
    pub ids: Option<Vec<String>>,
    pub limit: Option<usize>,
    pub cursor: Option<&'a str>,
}

pub fn list_report<S: StorePort>(
    engine: &MedhaEngine<S>,
    home: &str,
    now: i64,
    o: &ListOptions,
) -> Result<Value, Box<dyn std::error::Error>> {
    let status = o.status.map(require_status).transpose()?;
    let configured = engine.store().registries().kinds.clone();
    if let Some(k) = o.kind {
        if !configured.iter().any(|c| c == k) {
            return Err(Box::new(
                Failure::new(
                    "UnknownKindError",
                    crate::failure::UNKNOWN_REGISTRY_ENTRY,
                    "core",
                    format!("Unknown kind '{k}'"),
                )
                .with_context(json!({ "kind": "kind", "name": k, "entries": configured })),
            ));
        }
    }
    let filtered: Vec<Value> = all_hints(engine, now)?
        .into_iter()
        .filter(|h| {
            o.kind.is_none_or(|k| h["key"]["kind"] == k)
                && status.as_deref().is_none_or(|s| h["status"] == s)
                && o.namespace.is_none_or(|ns| h["key"]["namespace"] == ns)
                && o.drifting.is_none_or(|d| h["temporal"]["isDrifting"] == d)
                && o.ids
                    .as_ref()
                    .is_none_or(|ids| ids.iter().any(|id| h["key"]["id"] == id.as_str()))
        })
        .collect();
    let (limit, source) = match o.limit {
        Some(l) => (l, "caller"),
        None => (DEFAULT_RESULT_LIMIT, "default"),
    };
    let offset = o.cursor.map(decode_cursor).transpose()?.unwrap_or(0);
    let end = offset.saturating_add(limit);
    let total = filtered.len();
    let items: Vec<Value> = filtered.into_iter().skip(offset).take(limit).collect();
    let more = end < total;
    let mut filter = json!({});
    if let Some(k) = o.kind {
        filter["kind"] = json!(k);
    }
    if let Some(s) = &status {
        filter["status"] = json!(s);
    }
    if let Some(ns) = o.namespace {
        filter["namespace"] = json!(ns);
    }
    if let Some(d) = o.drifting {
        filter["drifting"] = json!(d);
    }
    if let Some(ids) = &o.ids {
        filter["ids"] = json!(ids);
    }
    let mut unregistered: Vec<String> = Vec::new();
    for h in &items {
        let k = h["key"]["kind"].as_str().unwrap_or("").to_string();
        if !configured.contains(&k) && !unregistered.contains(&k) {
            unregistered.push(k);
        }
    }
    let mut report = json!({
        "home": home,
        "asOf": now,
        "filter": filter,
        "page": {
            "items": items,
            "total": total,
            "nextCursor": if more { json!(encode_cursor(end)) } else { Value::Null },
            "limit": { "name": "limit", "applied": limit, "source": source, "reached": more },
        },
    });
    if !unregistered.is_empty() {
        report["unregisteredKinds"] = json!(unregistered);
    }
    Ok(report)
}

pub fn render_list(report: &Value) -> String {
    let page = &report["page"];
    let mut lines = vec![format!(
        "medha: {} entities (limit {}, source {}){}",
        page["total"],
        page["limit"]["applied"],
        page["limit"]["source"].as_str().unwrap_or(""),
        if page["limit"]["reached"] == json!(true) {
            ", truncated"
        } else {
            ""
        }
    )];
    let items = page["items"].as_array().cloned().unwrap_or_default();
    if !items.is_empty() {
        lines.push("  TRUST  STATUS     DRIFT  KEY".to_string());
        let unregistered: Vec<String> = report["unregisteredKinds"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        for h in &items {
            let key: EntityKey = serde_json::from_value(h["key"].clone())
                .unwrap_or_else(|_| EntityKey::new("", "", ""));
            lines.push(format!(
                "  {}  {:<10} {} {}{}",
                fixed(h["trustScore"].as_f64().unwrap_or(0.0)),
                h["status"].as_str().unwrap_or(""),
                if h["temporal"]["isDrifting"] == json!(true) {
                    "yes   "
                } else {
                    "no    "
                },
                key_label(&key),
                if unregistered.contains(&key.kind) {
                    "  [unregistered kind]"
                } else {
                    ""
                }
            ));
        }
        if !unregistered.is_empty() {
            lines.push(format!(
                "  warning: found {} unregistered {} ({}). Data is safe; run 'medha maintain preflight' for guidance.",
                unregistered.len(),
                if unregistered.len() == 1 { "kind" } else { "kinds" },
                unregistered.join(", ")
            ));
        }
    }
    if let Some(c) = page["nextCursor"].as_str() {
        lines.push(format!("  next page: --cursor {c}"));
    }
    format!("{}\n", lines.join("\n"))
}

/// The TypeScript `PreflightReport`.
pub fn preflight_json<S: StorePort>(
    engine: &MedhaEngine<S>,
    now: i64,
) -> Result<Value, MedhaError> {
    let pre = engine.preflight()?;
    let regs = engine.store().registries();
    let last_sweep = engine
        .store()
        .get_meta(LAST_SWEEP_META_KEY)?
        .and_then(|v| v.trim().parse::<i64>().ok());
    let fold_ok = !pre
        .issues
        .iter()
        .any(|i| i.to_lowercase().contains("mismatch"));
    let mut v = json!({
        "asOf": now,
        "status": if pre.ok { "ok" } else { "corrupt" },
        "location": Value::Null,
        "episodeCount": pre.total_episodes,
        "entityCount": pre.total_entities,
        "integrity": if fold_ok { "ok" } else { "fold-mismatch" },
        "danglingRetractions": [],
        "lastSweep": last_sweep,
        "registries": {
            "kinds": regs.kinds.len(),
            "signals": regs.signal_specs.len(),
            "anchors": regs.anchor_kinds.len(),
        },
    });
    if let Some(seq) = pre.corrupt_seq {
        v["location"] = json!({ "source": "", "atSeq": seq });
    }
    Ok(v)
}

pub fn status_report<S: StorePort>(
    engine: &MedhaEngine<S>,
    home: &str,
    backend: &str,
    path: Option<String>,
    now: i64,
) -> Result<Value, MedhaError> {
    let preflight = preflight_json(engine, now)?;
    let all = if preflight["status"] == "corrupt" {
        Vec::new()
    } else {
        all_hints(engine, now)?
    };
    let mut by_status = serde_json::Map::new();
    for s in LIFECYCLE_STATUSES {
        by_status.insert(
            s.to_string(),
            json!(all.iter().filter(|h| h["status"] == s).count()),
        );
    }
    let drifting = all
        .iter()
        .filter(|h| h["temporal"]["isDrifting"] == json!(true))
        .count();
    Ok(json!({
        "home": home,
        "asOf": now,
        "backend": backend,
        "path": path,
        "preflight": preflight,
        "byStatus": by_status,
        "drifting": drifting,
        "params": crate::params::params_report_ts(now, None),
    }))
}

fn last_sweep_text(p: &Value) -> String {
    p["lastSweep"]
        .as_i64()
        .map(ts_view::iso)
        .unwrap_or_else(|| "not yet".to_string())
}

pub fn render_status(report: &Value) -> String {
    let p = &report["preflight"];
    let by_status = report["byStatus"]
        .as_object()
        .map(|m| {
            LIFECYCLE_STATUSES
                .iter()
                .map(|s| format!("{s} {}", m.get(*s).cloned().unwrap_or(json!(0))))
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let mut lines = vec![
        format!(
            "medha: status for {}",
            report["home"].as_str().unwrap_or("")
        ),
        match report["path"].as_str() {
            Some(path) => format!("  store:      {path}"),
            None => "  store:      ephemeral (memory)".to_string(),
        },
        format!(
            "  preflight:  {} — {} episodes, {} entities, integrity {}",
            p["status"].as_str().unwrap_or(""),
            p["episodeCount"],
            p["entityCount"],
            p["integrity"].as_str().unwrap_or("")
        ),
        format!("  last sweep: {}", last_sweep_text(p)),
    ];
    if p["status"] == "corrupt" {
        lines.push(format!(
            "  by status:  unavailable — the log is unrecoverable from seq {}; run 'medha maintain preflight'",
            p["location"]["atSeq"]
        ));
    } else {
        lines.push(format!("  by status:  {by_status}"));
        lines.push(format!("  drifting:   {}", report["drifting"]));
    }
    lines.push(format!(
        "  registries: {} kinds, {} signals, {} anchors",
        p["registries"]["kinds"], p["registries"]["signals"], p["registries"]["anchors"]
    ));
    lines.push(
        "  params:     read-only canonical defaults — run `medha params` to see them".to_string(),
    );
    format!("{}\n", lines.join("\n"))
}

pub fn drift_report<S: StorePort>(
    engine: &MedhaEngine<S>,
    home: &str,
    now: i64,
    limit: Option<usize>,
) -> Result<Value, MedhaError> {
    let mut entries: Vec<Value> = all_hints(engine, now)?
        .into_iter()
        .filter(|h| h["temporal"]["isDrifting"] == json!(true))
        .map(|h| {
            json!({
                "key": h["key"],
                "delta": h["temporal"]["driftDelta"],
                "direction": h["temporal"]["driftDirection"],
                "hint": h,
            })
        })
        .collect();
    entries.sort_by(|a, b| {
        let da = a["delta"].as_f64().unwrap_or(0.0);
        let db = b["delta"].as_f64().unwrap_or(0.0);
        db.partial_cmp(&da)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| key_string(&a["key"]).cmp(&key_string(&b["key"])))
    });
    let count = entries.len();
    let applied = limit.unwrap_or(count);
    entries.truncate(applied);
    Ok(json!({
        "home": home,
        "report": { "asOf": now, "count": count, "limitApplied": applied, "drifting": entries },
    }))
}

pub fn render_drift(result: &Value) -> String {
    let r = &result["report"];
    let mut lines = vec![format!(
        "medha: {} entities drifting (limit applied {})",
        r["count"], r["limitApplied"]
    )];
    let entries = r["drifting"].as_array().cloned().unwrap_or_default();
    if !entries.is_empty() {
        lines.push(
            "  dir: down = below baseline (the direction that quarantines), up = above baseline (healthy)"
                .to_string(),
        );
    }
    for e in &entries {
        let key: EntityKey =
            serde_json::from_value(e["key"].clone()).unwrap_or_else(|_| EntityKey::new("", "", ""));
        lines.push(format!(
            "  {} {:<4} {:<10} {}",
            fixed(e["delta"].as_f64().unwrap_or(0.0)),
            e["direction"].as_str().unwrap_or(""),
            e["hint"]["status"].as_str().unwrap_or(""),
            key_label(&key)
        ));
    }
    format!("{}\n", lines.join("\n"))
}

fn format_number(v: f64) -> String {
    if v.fract() == 0.0 {
        format!("{}", v as i64)
    } else {
        format!("{v:.3}")
    }
}

fn num_text(v: &Value) -> String {
    match v.as_f64() {
        Some(x) if x.fract() == 0.0 => format!("{}", x as i64),
        Some(x) => format!("{x}"),
        None => v.to_string(),
    }
}

fn condition_label(c: &Value) -> String {
    let name = c["name"].as_str().unwrap_or("");
    if name == "guard" {
        return format!("guard last check passed: {}", c["actual"]);
    }
    let value = format_number(c["actual"].as_f64().unwrap_or(0.0));
    let expected = num_text(&c["expected"]);
    match name {
        "trust" => format!("trust {value} >= {expected}"),
        "uses" => format!("uses {value} >= {expected}"),
        "samples" => format!("samples {value} >= {expected}"),
        _ => format!("|mu - theta0| {value} >= {expected}"),
    }
}

pub fn explain_report<S: StorePort>(
    engine: &MedhaEngine<S>,
    home: &str,
    key: &EntityKey,
    now: i64,
) -> Result<Value, MedhaError> {
    let show = ts_view::show_report(engine, home, key, now, 10)?;
    let d = &show["detail"];
    let gates: Vec<Value> = d["gates"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|g| {
            json!({
                "name": g["name"],
                "met": g["met"],
                "threshold": g["threshold"],
                "value": g["value"],
                "conditions": g["conditions"].as_array().cloned().unwrap_or_default().iter().map(|c| json!({
                    "label": condition_label(c),
                    "met": c["met"],
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    let mut report = json!({
        "home": home,
        "asOf": now,
        "key": key_json(key),
        "known": d["known"],
        "hint": d["hint"],
        "gates": gates,
    });
    if !d["latch"].is_null() {
        report["latch"] = d["latch"].clone();
    }
    report["note"] =
        json!("Medha reports which thresholds clear and why; it never decides for the host.");
    Ok(report)
}

pub fn render_explain(report: &Value) -> String {
    let key: EntityKey = serde_json::from_value(report["key"].clone())
        .unwrap_or_else(|_| EntityKey::new("", "", ""));
    let mut out = format!(
        "medha: thresholds for {} ({})\n  trust:    {}  status: {}\n",
        key_label(&key),
        if report["known"] == json!(true) {
            "known"
        } else {
            "probation prior"
        },
        fixed(report["hint"]["trustScore"].as_f64().unwrap_or(0.0)),
        report["hint"]["status"].as_str().unwrap_or("")
    );
    out.push_str(&crate::render::latch_lines_value(&report["latch"]));
    for g in report["gates"].as_array().cloned().unwrap_or_default() {
        out.push_str(&format!(
            "  {}: {}\n",
            g["name"].as_str().unwrap_or(""),
            if g["met"] == json!(true) {
                "MET"
            } else {
                "not met"
            }
        ));
        for c in g["conditions"].as_array().cloned().unwrap_or_default() {
            out.push_str(&format!(
                "    {} {}\n",
                if c["met"] == json!(true) {
                    "ok    "
                } else {
                    "no    "
                },
                c["label"].as_str().unwrap_or("")
            ));
        }
    }
    out.push_str(&format!(
        "  note: {}\n",
        report["note"].as_str().unwrap_or("")
    ));
    out
}
