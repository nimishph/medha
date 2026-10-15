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

pub fn render_params(report: &ParamsReport) -> String {
    let mut out = Vec::new();
    out.push("medha: canonical model parameters:".to_string());
    out.push(format!("  note: {}", report.note));
    for param in &report.params {
        let unit_str = param
            .unit
            .as_ref()
            .map(|u| format!(" {}", u))
            .unwrap_or_default();
        out.push(format!(
            "  {:<26} {:<10}{}  ({})",
            param.name, param.value, unit_str, param.doc
        ));
    }
    out.push("".to_string());
    out.join("\n")
}
