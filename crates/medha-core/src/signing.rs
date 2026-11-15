//! Signed episodes, keyring, and verification (medha-nwf.4 / medha-nwf.7).
//! Spec §13: RFC 8785 canonical JSON payload, episodeId, keyId, Ed25519 verify.

use crate::types::CoreError;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub const EPISODE_DOMAIN: &str = "medha-episode-v1\n";
pub const SNAPSHOT_DOMAIN: &str = "medha-snapshot-v1\n";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyRole {
    Agent,
    Human,
    Maintainer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyRevocation {
    pub at: i64,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust_before: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyRecord {
    pub key_id: String,
    pub public_key: String,
    pub principal: String,
    pub roles: Vec<KeyRole>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespaces: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid_from: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid_until: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revoked: Option<KeyRevocation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supersedes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Keyring {
    pub version: u32,
    pub keys: Vec<KeyRecord>,
}

impl Default for Keyring {
    fn default() -> Self {
        Self {
            version: 1,
            keys: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SigningMode {
    Off,
    Warn,
    Require,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SigningPolicy {
    pub mode: SigningMode,
    pub keyring: Keyring,
    #[serde(default)]
    pub require_package_signature: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyOutcome {
    Unsigned,
    Verified {
        key_id: String,
        principal: String,
    },
    Invalid {
        key_id: Option<String>,
        reason: String,
    },
}

// -------------------------------------------------------------------------------------------------
// RFC 8785 Canonical JSON Serialization
// -------------------------------------------------------------------------------------------------

fn escape_json_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\x08' => out.push_str("\\b"),
            '\x0c' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

pub fn canonical_json(value: &serde_json::Value) -> Result<String, CoreError> {
    let mut out = String::new();
    format_canonical(value, &mut out)?;
    Ok(out)
}

fn format_canonical(value: &serde_json::Value, out: &mut String) -> Result<(), CoreError> {
    match value {
        serde_json::Value::Null => out.push_str("null"),
        serde_json::Value::Bool(true) => out.push_str("true"),
        serde_json::Value::Bool(false) => out.push_str("false"),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                out.push_str(&i.to_string());
            } else if let Some(u) = n.as_u64() {
                out.push_str(&u.to_string());
            } else if let Some(f) = n.as_f64() {
                if !f.is_finite() {
                    return Err(CoreError::NonFiniteNumber(f));
                }
                // In ECMAScript JSON.stringify, integer floats like 1.0 serialize as "1".
                if f.fract() == 0.0 && f >= (i64::MIN as f64) && f <= (i64::MAX as f64) {
                    out.push_str(&(f as i64).to_string());
                } else {
                    out.push_str(&f.to_string());
                }
            }
        }
        serde_json::Value::String(s) => escape_json_string(s, out),
        serde_json::Value::Array(arr) => {
            out.push('[');
            for (idx, item) in arr.iter().enumerate() {
                if idx > 0 {
                    out.push(',');
                }
                format_canonical(item, out)?;
            }
            out.push(']');
        }
        serde_json::Value::Object(map) => {
            out.push('{');
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            for (idx, key) in keys.iter().enumerate() {
                if idx > 0 {
                    out.push(',');
                }
                escape_json_string(key, out);
                out.push(':');
                format_canonical(&map[*key], out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

// -------------------------------------------------------------------------------------------------
// Signable payload, episodeId, and keyId
// -------------------------------------------------------------------------------------------------

/// Strip `seq`, `sig`, and retract's `targetSeq` / `target_seq`.
pub fn signable_value(episode: &serde_json::Value) -> serde_json::Value {
    if let serde_json::Value::Object(map) = episode {
        let mut clean = serde_json::Map::new();
        let is_retract = map.get("type").and_then(|v| v.as_str()) == Some("retract");
        for (k, v) in map {
            if k == "seq" || k == "sig" {
                continue;
            }
            if is_retract && (k == "targetSeq" || k == "target_seq") {
                continue;
            }
            clean.insert(k.clone(), v.clone());
        }
        serde_json::Value::Object(clean)
    } else {
        episode.clone()
    }
}

pub fn signing_payload_for_value(episode: &serde_json::Value) -> Result<Vec<u8>, CoreError> {
    let signable = signable_value(episode);
    let canonical = canonical_json(&signable)?;
    let mut payload = Vec::with_capacity(EPISODE_DOMAIN.len() + canonical.len());
    payload.extend_from_slice(EPISODE_DOMAIN.as_bytes());
    payload.extend_from_slice(canonical.as_bytes());
    Ok(payload)
}

pub fn episode_id_for_value(episode: &serde_json::Value) -> Result<String, CoreError> {
    let payload = signing_payload_for_value(episode)?;
    let hash = Sha256::digest(&payload);
    Ok(URL_SAFE_NO_PAD.encode(hash))
}

pub fn key_id_for(public_key_base64url: &str) -> Result<String, CoreError> {
    let raw = URL_SAFE_NO_PAD
        .decode(public_key_base64url.as_bytes())
        .map_err(|e| CoreError::InvalidArgument {
            name: "publicKey",
            reason: format!("invalid base64url: {}", e),
        })?;
    if raw.len() != 32 {
        return Err(CoreError::InvalidArgument {
            name: "publicKey",
            reason: format!("expected 32 bytes, got {}", raw.len()),
        });
    }
    let hash = Sha256::digest(&raw);
    Ok(format!("ed25519:{}", URL_SAFE_NO_PAD.encode(&hash[..16])))
}

pub fn author_matches_principal(author: Option<&str>, principal: &str) -> bool {
    match author {
        Some(a) => a == principal || a.starts_with(&format!("{}/", principal)),
        None => false,
    }
}

// -------------------------------------------------------------------------------------------------
// Verification
// -------------------------------------------------------------------------------------------------

pub fn verify_episode_value(episode: &serde_json::Value, keyring: &Keyring) -> VerifyOutcome {
    let sig_val = match episode.get("sig") {
        Some(s) if s.is_object() => s,
        _ => return VerifyOutcome::Unsigned,
    };

    let key_id = sig_val.get("keyId").and_then(|v| v.as_str());
    let sig_str = sig_val.get("value").and_then(|v| v.as_str());
    let (key_id, sig_str) = match (key_id, sig_str) {
        (Some(kid), Some(s)) => (kid, s),
        _ => return VerifyOutcome::Unsigned,
    };

    let invalid = |reason: &str| VerifyOutcome::Invalid {
        key_id: Some(key_id.to_string()),
        reason: reason.to_string(),
    };

    let record = match keyring.keys.iter().find(|k| k.key_id == key_id) {
        Some(r) => r,
        None => return invalid("unknown key"),
    };

    let pk_bytes = match URL_SAFE_NO_PAD.decode(record.public_key.as_bytes()) {
        Ok(b) if b.len() == 32 => {
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&b);
            arr
        }
        _ => return invalid("invalid public key in keyring"),
    };

    let verifying_key = match VerifyingKey::from_bytes(&pk_bytes) {
        Ok(vk) => vk,
        Err(_) => return invalid("bad public key"),
    };

    let sig_bytes = match URL_SAFE_NO_PAD.decode(sig_str.as_bytes()) {
        Ok(b) if b.len() == 64 => {
            let mut arr = [0u8; 64];
            arr.copy_from_slice(&b);
            Signature::from_bytes(&arr)
        }
        _ => return invalid("bad signature encoding"),
    };

    let payload = match signing_payload_for_value(episode) {
        Ok(p) => p,
        Err(_) => return invalid("failed to compute signing payload"),
    };

    if verifying_key.verify(&payload, &sig_bytes).is_err() {
        return invalid("bad signature");
    }

    let author = episode.get("author").and_then(|v| v.as_str());
    if !author_matches_principal(author, &record.principal) {
        return invalid(&format!(
            "author '{}' is not principal '{}'",
            author.unwrap_or(""),
            record.principal
        ));
    }

    if let Some(a) = author {
        if a.starts_with("human:") && !record.roles.contains(&KeyRole::Human) {
            return invalid("a 'human:' author needs a key with the human role");
        }
    }

    let ep_type = episode.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if (ep_type == "baseline" || ep_type == "override")
        && !record.roles.contains(&KeyRole::Maintainer)
    {
        return invalid(&format!(
            "a '{}' episode needs a key with the maintainer role",
            ep_type
        ));
    }

    let ep_ns = episode
        .get("key")
        .and_then(|k| k.get("namespace"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if let Some(allowed_namespaces) = &record.namespaces {
        if !allowed_namespaces.iter().any(|ns| ns == ep_ns) {
            return invalid(&format!("namespace '{}' is outside the key's scope", ep_ns));
        }
    }

    let ep_at = episode.get("at").and_then(|v| v.as_i64()).unwrap_or(0);
    if let Some(vf) = record.valid_from {
        if ep_at < vf {
            return invalid("episode predates the key");
        }
    }
    if let Some(vu) = record.valid_until {
        if ep_at >= vu {
            return invalid("key was rotated out before this episode");
        }
    }
    if let Some(rev) = &record.revoked {
        if rev.trust_before.map(|tb| ep_at >= tb).unwrap_or(true) {
            return invalid("key revoked");
        }
    }

    if ep_type == "retract" {
        let has_target_id = episode
            .get("targetId")
            .or_else(|| episode.get("target_id"))
            .is_some();
        if !has_target_id {
            return invalid("a signed retract must carry targetId");
        }
    }

    VerifyOutcome::Verified {
        key_id: record.key_id.clone(),
        principal: record.principal.clone(),
    }
}

pub fn validate_keyring(raw: &serde_json::Value) -> Result<Keyring, CoreError> {
    let doc = raw.as_object().ok_or_else(|| CoreError::InvalidArgument {
        name: "keyring",
        reason: "an object {version: 1, keys: [...]}".to_string(),
    })?;

    let version =
        doc.get("version")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| CoreError::InvalidArgument {
                name: "keyring.version",
                reason: "1".to_string(),
            })?;
    if version != 1 {
        return Err(CoreError::InvalidArgument {
            name: "keyring.version",
            reason: "1".to_string(),
        });
    }

    let keys_arr =
        doc.get("keys")
            .and_then(|v| v.as_array())
            .ok_or_else(|| CoreError::InvalidArgument {
                name: "keyring.keys",
                reason: "an array".to_string(),
            })?;

    let mut seen = HashSet::new();
    let mut records = Vec::with_capacity(keys_arr.len());

    for (idx, entry) in keys_arr.iter().enumerate() {
        let at = format!("keyring.keys[{}]", idx);
        let obj = entry
            .as_object()
            .ok_or_else(|| CoreError::InvalidArgument {
                name: "keyring.keys",
                reason: format!("{}: a key record", at),
            })?;

        let public_key = obj
            .get("publicKey")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::InvalidArgument {
                name: "keyring.keys.publicKey",
                reason: format!("{}.publicKey: a base64url string", at),
            })?;

        let derived = key_id_for(public_key)?;
        let key_id = obj.get("keyId").and_then(|v| v.as_str()).ok_or_else(|| {
            CoreError::InvalidArgument {
                name: "keyring.keys.keyId",
                reason: format!("{}.keyId: string", at),
            }
        })?;
        if key_id != derived {
            return Err(CoreError::InvalidArgument {
                name: "keyring.keys.keyId",
                reason: format!("{}.keyId must match derived id ({})", at, derived),
            });
        }
        if !seen.insert(derived.clone()) {
            return Err(CoreError::InvalidArgument {
                name: "keyring.keys.keyId",
                reason: format!("{}.keyId must be unique", at),
            });
        }

        let principal = obj
            .get("principal")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::InvalidArgument {
                name: "keyring.keys.principal",
                reason: format!("{}.principal: a non-empty string", at),
            })?;
        if principal.trim().is_empty() || principal.contains('/') {
            return Err(CoreError::InvalidArgument {
                name: "keyring.keys.principal",
                reason: format!("{}.principal: a non-empty string without '/'", at),
            });
        }

        let roles_arr = obj.get("roles").and_then(|v| v.as_array()).ok_or_else(|| {
            CoreError::InvalidArgument {
                name: "keyring.keys.roles",
                reason: format!("{}.roles: array", at),
            }
        })?;
        if roles_arr.is_empty() {
            return Err(CoreError::InvalidArgument {
                name: "keyring.keys.roles",
                reason: format!("{}.roles: non-empty array", at),
            });
        }
        let mut roles = Vec::new();
        for r_val in roles_arr {
            let r_str = r_val.as_str().unwrap_or("");
            let role = match r_str {
                "agent" => KeyRole::Agent,
                "human" => KeyRole::Human,
                "maintainer" => KeyRole::Maintainer,
                _ => {
                    return Err(CoreError::InvalidArgument {
                        name: "keyring.keys.roles",
                        reason: format!("unknown role: {}", r_str),
                    });
                }
            };
            roles.push(role);
        }

        let namespaces = if let Some(ns_val) = obj.get("namespaces") {
            let ns_arr = ns_val
                .as_array()
                .ok_or_else(|| CoreError::InvalidArgument {
                    name: "keyring.keys.namespaces",
                    reason: "array of strings".to_string(),
                })?;
            let mut list = Vec::new();
            for s in ns_arr {
                list.push(s.as_str().unwrap_or("").to_string());
            }
            Some(list)
        } else {
            None
        };

        let valid_from = obj.get("validFrom").and_then(|v| v.as_i64());
        let valid_until = obj.get("validUntil").and_then(|v| v.as_i64());

        let revoked = if let Some(rev_val) = obj.get("revoked") {
            if rev_val.is_null() {
                None
            } else {
                let rev_obj = rev_val
                    .as_object()
                    .ok_or_else(|| CoreError::InvalidArgument {
                        name: "keyring.keys.revoked",
                        reason: "object".to_string(),
                    })?;
                let at = rev_obj.get("at").and_then(|v| v.as_i64()).ok_or_else(|| {
                    CoreError::InvalidArgument {
                        name: "keyring.keys.revoked.at",
                        reason: "epoch-ms number".to_string(),
                    }
                })?;
                let reason = rev_obj
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let trust_before = rev_obj.get("trustBefore").and_then(|v| v.as_i64());
                Some(KeyRevocation {
                    at,
                    reason,
                    trust_before,
                })
            }
        } else {
            None
        };

        let supersedes = obj
            .get("supersedes")
            .and_then(|v| v.as_str())
            .map(String::from);
        let comment = obj
            .get("comment")
            .and_then(|v| v.as_str())
            .map(String::from);

        records.push(KeyRecord {
            key_id: derived,
            public_key: public_key.to_string(),
            principal: principal.to_string(),
            roles,
            namespaces,
            valid_from,
            valid_until,
            revoked,
            supersedes,
            comment,
        });
    }

    Ok(Keyring {
        version: 1,
        keys: records,
    })
}

// -------------------------------------------------------------------------------------------------
// Sync Package Signatures (medha-nwf.8)
// -------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageSignature {
    pub key_id: String,
    pub value: String,
}

pub fn snapshot_signing_payload(snapshot_json_bytes: &[u8]) -> Vec<u8> {
    let mut payload = Vec::with_capacity(SNAPSHOT_DOMAIN.len() + snapshot_json_bytes.len());
    payload.extend_from_slice(SNAPSHOT_DOMAIN.as_bytes());
    payload.extend_from_slice(snapshot_json_bytes);
    payload
}

pub fn verify_snapshot_signature(
    snapshot_json_bytes: &[u8],
    sig: &PackageSignature,
    keyring: &Keyring,
) -> VerifyOutcome {
    let invalid = |reason: &str| VerifyOutcome::Invalid {
        key_id: Some(sig.key_id.clone()),
        reason: reason.to_string(),
    };

    let record = match keyring.keys.iter().find(|k| k.key_id == sig.key_id) {
        Some(r) => r,
        None => return invalid("unknown key"),
    };

    let pk_bytes = match URL_SAFE_NO_PAD.decode(record.public_key.as_bytes()) {
        Ok(b) if b.len() == 32 => {
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&b);
            arr
        }
        _ => return invalid("invalid public key in keyring"),
    };

    let verifying_key = match VerifyingKey::from_bytes(&pk_bytes) {
        Ok(vk) => vk,
        Err(_) => return invalid("bad public key"),
    };

    let sig_bytes = match URL_SAFE_NO_PAD.decode(sig.value.as_bytes()) {
        Ok(b) if b.len() == 64 => {
            let mut arr = [0u8; 64];
            arr.copy_from_slice(&b);
            Signature::from_bytes(&arr)
        }
        _ => return invalid("bad signature encoding"),
    };

    let payload = snapshot_signing_payload(snapshot_json_bytes);
    if verifying_key.verify(&payload, &sig_bytes).is_err() {
        return invalid("bad signature");
    }

    if record.revoked.is_some() {
        return invalid("key revoked");
    }

    VerifyOutcome::Verified {
        key_id: record.key_id.clone(),
        principal: record.principal.clone(),
    }
}
