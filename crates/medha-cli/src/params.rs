use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParamEntry {
    pub name: String,
    pub value: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    pub source: String,
    pub doc: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParamsReport {
    #[serde(rename = "asOf")]
    pub as_of: i64,
    pub note: String,
    pub params: Vec<ParamEntry>,
}

use medha::core::thresholds::{
    ACTIVE_THRESHOLD, DEFAULT_EMA_ALPHA, DEFAULT_THETA0, DRIFT_THRESHOLD, DURABILITY_GAIN,
    DURABILITY_MAX, MIN_DISTINCT_AUTHORS_FOR_RETIRED, MIN_SAMPLES_FOR_DRIFT, MIN_USES_FOR_RETIRED,
    MIN_USES_FOR_TRUSTED, RECENCY_FLOOR, RECENCY_HALF_LIFE_DAYS, RETIRED_TRUST_THRESHOLD,
    SKIP_SIGNAL, TRUSTED_THRESHOLD, TRUST_SPEC_VERSION, UNGUARDED_TRUST_CEILING, WILSON_Z,
};

const SOURCE_THRESHOLDS: &str = "medha-core: thresholds.rs";

fn param(name: &str, value: serde_json::Value, doc: &str) -> ParamEntry {
    ParamEntry {
        name: name.to_string(),
        value,
        unit: None,
        source: SOURCE_THRESHOLDS.to_string(),
        doc: doc.to_string(),
    }
}

/// The parameter catalog, read from the constants the kernel uses: a hand-typed table drifted from
/// them (it listed trusted 0.85 and active 0.50 against 0.6 and 0.25 in the kernel, gh-19).
pub fn params_report(as_of: i64) -> ParamsReport {
    use serde_json::json;
    ParamsReport {
        as_of,
        note: format!(
            "read-only: model parameters are canonical constants in medha-core \
             (trust spec {TRUST_SPEC_VERSION}); per-kind overrides live in config.json"
        ),
        params: vec![
            param(
                "WILSON_Z",
                json!(WILSON_Z),
                "Normal quantile, 95% confidence",
            ),
            param(
                "TRUSTED_THRESHOLD",
                json!(TRUSTED_THRESHOLD),
                "Trust at/above this may become trusted (with guard 1.0 and enough uses)",
            ),
            param(
                "MIN_USES_FOR_TRUSTED",
                json!(MIN_USES_FOR_TRUSTED),
                "Minimum trials before trusted is reachable",
            ),
            param(
                "ACTIVE_THRESHOLD",
                json!(ACTIVE_THRESHOLD),
                "Trust at/above this may become active",
            ),
            param(
                "RETIRED_TRUST_THRESHOLD",
                json!(RETIRED_TRUST_THRESHOLD),
                "Undecayed trust (Wilson bound x guard) below this retires an entity",
            ),
            param(
                "MIN_USES_FOR_RETIRED",
                json!(MIN_USES_FOR_RETIRED),
                "Minimum trials before an entity can be retired by trust",
            ),
            param(
                "MIN_DISTINCT_AUTHORS_FOR_RETIRED",
                json!(MIN_DISTINCT_AUTHORS_FOR_RETIRED),
                "Distinct authors needed among the failed trials before retirement (1: none)",
            ),
            param(
                "UNGUARDED_TRUST_CEILING",
                json!(UNGUARDED_TRUST_CEILING),
                "Hard ceiling on the trust of an unguarded entity (IV)",
            ),
            param(
                "SKIP_SIGNAL",
                json!(SKIP_SIGNAL),
                "Neutral skip signal value",
            ),
            param(
                "RECENCY_HALF_LIFE_DAYS",
                json!(RECENCY_HALF_LIFE_DAYS),
                "Recency decay half-life in days",
            ),
            param(
                "RECENCY_FLOOR",
                json!(RECENCY_FLOOR),
                "Recency retention floor",
            ),
            param(
                "DURABILITY_GAIN",
                json!(DURABILITY_GAIN),
                "Durability gain per distinct anchor",
            ),
            param(
                "DURABILITY_MAX",
                json!(DURABILITY_MAX),
                "Durability multiplier ceiling",
            ),
            param(
                "DEFAULT_THETA0",
                json!(DEFAULT_THETA0),
                "Author-declared baseline prior for a fresh entity",
            ),
            param(
                "DEFAULT_EMA_ALPHA",
                json!(DEFAULT_EMA_ALPHA),
                "Default EMA smoothing parameter",
            ),
            param(
                "MIN_SAMPLES_FOR_DRIFT",
                json!(MIN_SAMPLES_FOR_DRIFT),
                "Minimum trials before drift is detectable",
            ),
            param(
                "DRIFT_THRESHOLD",
                json!(DRIFT_THRESHOLD),
                "|mu - theta0| at/above this flags drift",
            ),
        ],
    }
}

/// The TypeScript `ParamsReport` (`cli/src/read.ts` `paramsReport`): the same catalog with the
/// TypeScript note and sources, the sweep constants, and the configured kind specs.
pub fn params_report_ts(
    as_of: i64,
    kind_specs: Option<&[medha::core::fold::KindSpec]>,
) -> serde_json::Value {
    use serde_json::json;
    let base = params_report(as_of);
    let ema = [
        "DEFAULT_EMA_ALPHA",
        "MIN_SAMPLES_FOR_DRIFT",
        "DRIFT_THRESHOLD",
    ];
    let mut params: Vec<serde_json::Value> = base
        .params
        .iter()
        .map(|p| {
            json!({
                "name": p.name,
                "value": p.value,
                "source": if ema.contains(&p.name.as_str()) { "medha-core: ema.ts" } else { "medha-core: thresholds.ts" },
                "doc": p.doc,
            })
        })
        .collect();
    for (name, value, unit, doc) in [
        (
            "DEFAULT_SWEEP_INTERVAL_MS",
            json!(DEFAULT_SWEEP_INTERVAL_MS),
            "ms",
            "Session-start sweep cadence",
        ),
        (
            "DEFAULT_FOLD_DAYS",
            json!(medha::maintenance::DEFAULT_FOLD_DAYS as i64),
            "days",
            "Episodes older than this fold into baselines",
        ),
        (
            "DEFAULT_RETENTION_DAYS",
            json!(DEFAULT_RETENTION_DAYS),
            "days",
            "Stale entities older than this are retired",
        ),
    ] {
        params.push(json!({ "name": name, "value": value, "unit": unit, "source": "medha: maintenance.ts", "doc": doc }));
    }
    let mut v = json!({
        "asOf": as_of,
        "note": "read-only: model parameters are canonical constants in medha-core — the lean engine has no mutable params store",
        "params": params,
    });
    if let Some(specs) = kind_specs.filter(|s| !s.is_empty()) {
        v["kinds"] = serde_json::to_value(specs).unwrap_or(json!([]));
    }
    v
}

/// `DEFAULT_SWEEP_INTERVAL_MS` and `DEFAULT_RETENTION_DAYS` from `medha/src/maintenance.ts`.
pub const DEFAULT_SWEEP_INTERVAL_MS: i64 = 86_400_000;
pub const DEFAULT_RETENTION_DAYS: i64 = 90;

/// `medha params`, as the TypeScript `renderParams` prints it.
pub fn render_params_ts(report: &serde_json::Value) -> String {
    let mut lines = vec![
        "medha: canonical model parameters (read-only)".to_string(),
        format!("  note: {}", report["note"].as_str().unwrap_or("")),
        "  NAME                          VALUE      SOURCE".to_string(),
    ];
    for p in report["params"].as_array().cloned().unwrap_or_default() {
        let value = match p["value"].as_f64() {
            Some(v) => format!("{v:.3}"),
            None => p["value"].as_str().unwrap_or("").to_string(),
        };
        lines.push(format!(
            "  {:<28} {:>8}   {}",
            p["name"].as_str().unwrap_or(""),
            value,
            p["source"].as_str().unwrap_or("")
        ));
    }
    if let Some(kinds) = report["kinds"].as_array().filter(|k| !k.is_empty()) {
        lines.push(String::new());
        lines.push("  CONFIGURED KIND TRUST CONFIGURATIONS:".to_string());
        for k in kinds {
            lines.push(format!(
                "    - kind '{}':",
                k["name"].as_str().unwrap_or("")
            ));
            if let Some(d) = k["description"].as_str() {
                lines.push(format!("        description: {d}"));
            }
            if let Some(w) = k["evidenceWeighting"].as_str() {
                lines.push(format!("        evidenceWeighting: {w}"));
            }
            if !k["thresholds"].is_null() {
                lines.push(format!("        thresholds: {}", k["thresholds"]));
            }
            if !k["recency"].is_null() {
                lines.push(format!("        recency: {}", k["recency"]));
            }
        }
    }
    format!("{}\n", lines.join("\n"))
}
