use crate::errors::SyncError;
use medha_store::{EntityState, Episode, StoreRegistries};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const CURRENT_MEMORY_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySnapshotV1 {
    pub schema_version: u32,
    pub as_of: i64,
    #[serde(default)]
    pub registries: Option<StoreRegistries>,
    pub entities: Vec<EntityState>,
    #[serde(default)]
    pub episodes: Option<Vec<Episode>>,
    #[serde(default)]
    pub meta: Option<HashMap<String, String>>,
}

pub fn serialize_snapshot(snapshot: &MemorySnapshotV1) -> Result<String, serde_json::Error> {
    let mut json = serde_json::to_string_pretty(snapshot)?;
    json.push('\n');
    Ok(json)
}

pub fn migrate_snapshot(raw: serde_json::Value) -> Result<MemorySnapshotV1, SyncError> {
    let obj = raw
        .as_object()
        .ok_or_else(|| SyncError::InvalidSnapshot("Snapshot must be a JSON object".to_string()))?;

    // Check version
    let mut version = obj
        .get("formatVersion")
        .or_else(|| obj.get("schemaVersion"))
        .or_else(|| obj.get("layoutVersion"))
        .or_else(|| obj.get("version"))
        .and_then(|v| v.as_u64())
        .map(|v| v as u32);

    if version.is_none() {
        if let Some(fmt) = obj.get("format").and_then(|v| v.as_str()) {
            if let Some(v_str) = fmt.strip_prefix("sutras.medha/v").or_else(|| fmt.strip_prefix("sutras.sage/v")) {
                if let Ok(parsed) = v_str.parse::<u32>() {
                    version = Some(parsed);
                }
            }
        }
    }

    if let Some(v) = version {
        if v > CURRENT_MEMORY_SCHEMA_VERSION {
            return Err(SyncError::SchemaVersionMismatch {
                expected: CURRENT_MEMORY_SCHEMA_VERSION,
                found: v,
            });
        }
    }

    // Extract entities
    let entities: Vec<EntityState> = if let Some(arr) = obj.get("entities").and_then(|v| v.as_array()) {
        serde_json::from_value(serde_json::Value::Array(arr.clone()))?
    } else if let Some(rules_obj) = obj.get("rules").and_then(|v| v.as_object()) {
        let vals: Vec<serde_json::Value> = rules_obj.values().cloned().collect();
        serde_json::from_value(serde_json::Value::Array(vals))?
    } else {
        Vec::new()
    };

    let as_of = obj
        .get("exportedAt")
        .or_else(|| obj.get("asOf"))
        .or_else(|| obj.get("last_state_update"))
        .and_then(|v| v.as_i64())
        .unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0)
        });

    let registries: Option<StoreRegistries> = match obj.get("registries") {
        Some(reg) if !reg.is_null() => Some(serde_json::from_value(reg.clone())?),
        _ => None,
    };

    let episodes: Option<Vec<Episode>> = match obj.get("episodes") {
        Some(eps) if !eps.is_null() => {
            if let Some(arr) = eps.as_array() {
                let mut normalized_arr = arr.clone();
                for item in &mut normalized_arr {
                    normalize_episode_value(item);
                }
                Some(serde_json::from_value(serde_json::Value::Array(normalized_arr))?)
            } else {
                None
            }
        }
        _ => None,
    };

    let meta: Option<HashMap<String, String>> = match obj.get("meta") {
        Some(m) if !m.is_null() => Some(serde_json::from_value(m.clone())?),
        _ => None,
    };

    Ok(MemorySnapshotV1 {
        schema_version: CURRENT_MEMORY_SCHEMA_VERSION,
        as_of,
        registries,
        entities,
        episodes,
        meta,
    })
}

fn normalize_episode_value(ep: &mut serde_json::Value) {
    if let Some(obj) = ep.as_object_mut() {
        if obj.get("type").and_then(|v| v.as_str()) == Some("signal") {
            if let Some(spec) = obj.get_mut("spec").and_then(|v| v.as_object_mut()) {
                let name_owned = spec
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("APPLY")
                    .to_string();
                let normalized_name = match name_owned.as_str() {
                    "APPLY_RULE" => "APPLY".to_string(),
                    "REJECT" => "REJECT_RULE".to_string(),
                    other => other.to_string(),
                };
                spec.insert(
                    "name".to_string(),
                    serde_json::Value::String(normalized_name.clone()),
                );

                let val = if let Some(v) = spec.get("value").and_then(|v| v.as_f64()) {
                    v
                } else if let Some(v) = spec.get("valence").and_then(|v| v.as_f64()) {
                    spec.insert("value".to_string(), serde_json::json!(v));
                    v
                } else {
                    spec.insert("value".to_string(), serde_json::json!(1.0));
                    1.0
                };

                if !spec.contains_key("countsAsTrial") && !spec.contains_key("counts_as_trial") {
                    let counts_as_trial = match normalized_name.as_str() {
                        "SKIP" | "REJECT_CONTEXT" => false,
                        _ => val != 0.0,
                    };
                    spec.insert("countsAsTrial".to_string(), serde_json::json!(counts_as_trial));
                }

                if !spec.contains_key("countsAsSuccess") && !spec.contains_key("counts_as_success") {
                    let counts_as_success = match normalized_name.as_str() {
                        "SKIP" | "REJECT_CONTEXT" | "REJECT_RULE" => false,
                        _ => val > 0.0,
                    };
                    spec.insert("countsAsSuccess".to_string(), serde_json::json!(counts_as_success));
                }
            }
        }
    }
}
