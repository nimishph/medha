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

const SOURCE_EMA: &str = "medha-core: ema.ts";
const SOURCE_SWEEP: &str = "medha: maintenance.ts";
const SOURCE_THRESHOLDS: &str = "medha-core: thresholds.ts";

pub fn params_report(as_of: i64) -> ParamsReport {
    ParamsReport {
        as_of,
        note: "read-only: model parameters are canonical constants in medha-core — the lean engine has no mutable params store".to_string(),
        params: vec![
            ParamEntry {
                name: "WILSON_Z".to_string(),
                value: serde_json::json!(1.959964),
                unit: None,
                source: SOURCE_THRESHOLDS.to_string(),
                doc: "Normal quantile, 95% confidence".to_string(),
            },
            ParamEntry {
                name: "TRUSTED_THRESHOLD".to_string(),
                value: serde_json::json!(0.85),
                unit: None,
                source: SOURCE_THRESHOLDS.to_string(),
                doc: "Trust at/above this may become trusted (with guard 1.0 and enough uses)".to_string(),
            },
            ParamEntry {
                name: "MIN_USES_FOR_TRUSTED".to_string(),
                value: serde_json::json!(3),
                unit: None,
                source: SOURCE_THRESHOLDS.to_string(),
                doc: "Minimum trials before trusted is reachable".to_string(),
            },
            ParamEntry {
                name: "ACTIVE_THRESHOLD".to_string(),
                value: serde_json::json!(0.50),
                unit: None,
                source: SOURCE_THRESHOLDS.to_string(),
                doc: "Trust at/above this may become active".to_string(),
            },
            ParamEntry {
                name: "RETIRED_TRUST_THRESHOLD".to_string(),
                value: serde_json::json!(0.20),
                unit: None,
                source: SOURCE_THRESHOLDS.to_string(),
                doc: "Trust below this retires an entity".to_string(),
            },
            ParamEntry {
                name: "UNGUARDED_TRUST_CEILING".to_string(),
                value: serde_json::json!(0.85),
                unit: None,
                source: SOURCE_THRESHOLDS.to_string(),
                doc: "Hard ceiling on the trust of an unguarded entity (IV)".to_string(),
            },
            ParamEntry {
                name: "SKIP_SIGNAL".to_string(),
                value: serde_json::json!(0.0),
                unit: None,
                source: SOURCE_THRESHOLDS.to_string(),
                doc: "Neutral skip signal value".to_string(),
            },
            ParamEntry {
                name: "RECENCY_HALF_LIFE_DAYS".to_string(),
                value: serde_json::json!(30.0),
                unit: None,
                source: SOURCE_THRESHOLDS.to_string(),
                doc: "Recency decay half-life in days".to_string(),
            },
            ParamEntry {
                name: "RECENCY_FLOOR".to_string(),
                value: serde_json::json!(0.10),
                unit: None,
                source: SOURCE_THRESHOLDS.to_string(),
                doc: "Recency retention floor".to_string(),
            },
            ParamEntry {
                name: "DURABILITY_GAIN".to_string(),
                value: serde_json::json!(0.05),
                unit: None,
                source: SOURCE_THRESHOLDS.to_string(),
                doc: "Durability gain per distinct anchor".to_string(),
            },
            ParamEntry {
                name: "DURABILITY_MAX".to_string(),
                value: serde_json::json!(1.50),
                unit: None,
                source: SOURCE_THRESHOLDS.to_string(),
                doc: "Durability multiplier ceiling".to_string(),
            },
            ParamEntry {
                name: "DEFAULT_THETA0".to_string(),
                value: serde_json::json!(0.50),
                unit: None,
                source: SOURCE_THRESHOLDS.to_string(),
                doc: "Author-declared baseline prior for a fresh entity".to_string(),
            },
            ParamEntry {
                name: "DEFAULT_EMA_ALPHA".to_string(),
                value: serde_json::json!(0.20),
                unit: None,
                source: SOURCE_EMA.to_string(),
                doc: "Default EMA smoothing parameter".to_string(),
            },
            ParamEntry {
                name: "MIN_SAMPLES_FOR_DRIFT".to_string(),
                value: serde_json::json!(3),
                unit: None,
                source: SOURCE_EMA.to_string(),
                doc: "Minimum trials before drift is detectable".to_string(),
            },
            ParamEntry {
                name: "DRIFT_THRESHOLD".to_string(),
                value: serde_json::json!(0.15),
                unit: None,
                source: SOURCE_EMA.to_string(),
                doc: "|mu - theta0| at/above this flags drift".to_string(),
            },
            ParamEntry {
                name: "DEFAULT_SWEEP_INTERVAL_MS".to_string(),
                value: serde_json::json!(86400000),
                unit: Some("ms".to_string()),
                source: SOURCE_SWEEP.to_string(),
                doc: "Session-start sweep cadence".to_string(),
            },
            ParamEntry {
                name: "DEFAULT_FOLD_DAYS".to_string(),
                value: serde_json::json!(14),
                unit: Some("days".to_string()),
                source: SOURCE_SWEEP.to_string(),
                doc: "Episodes older than this fold into baselines".to_string(),
            },
            ParamEntry {
                name: "DEFAULT_RETENTION_DAYS".to_string(),
                value: serde_json::json!(90),
                unit: Some("days".to_string()),
                source: SOURCE_SWEEP.to_string(),
                doc: "Stale entities older than this are retired".to_string(),
            },
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
