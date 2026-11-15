//! `medha keys` command implementation (medha-nwf.4 / medha-nwf.7).

use crate::args::{
    KeysArgs, KeysGenerateArgs, KeysModeArgs, KeysRevokeArgs, KeysRotateArgs, KeysSubcommand,
};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::SigningKey;
use medha::store::StorePort;
use medha::MedhaEngine;
use medha_core::signing::{
    key_id_for, validate_keyring, verify_episode_value, KeyRecord, KeyRevocation, KeyRole, Keyring,
    VerifyOutcome,
};
use std::fs;
use std::path::{Path, PathBuf};

fn keyring_path(home_dir: &Path) -> PathBuf {
    home_dir.join("keys").join("keyring.json")
}

fn config_path(home_dir: &Path) -> PathBuf {
    home_dir.join("config.json")
}

fn key_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("MEDHA_KEY_DIR") {
        return PathBuf::from(dir);
    }
    if cfg!(windows) {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata).join("medha").join("keys");
        }
    }
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        return PathBuf::from(xdg).join("medha").join("keys");
    }
    if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        return PathBuf::from(home).join(".config").join("medha").join("keys");
    }
    PathBuf::from(".medha_keys")
}

fn private_key_path(key_id: &str) -> PathBuf {
    let safe_id = key_id.replace(':', "_");
    key_dir().join(format!("{}.key", safe_id))
}

fn load_keyring(home_dir: &Path) -> Result<Keyring, Box<dyn std::error::Error>> {
    let path = keyring_path(home_dir);
    if !path.exists() {
        return Ok(Keyring::default());
    }
    let data = fs::read_to_string(&path)?;
    let val: serde_json::Value = serde_json::from_str(&data)?;
    Ok(validate_keyring(&val)?)
}

fn save_keyring(home_dir: &Path, keyring: &Keyring) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let val = serde_json::to_value(keyring)?;
    validate_keyring(&val)?;
    let path = keyring_path(home_dir);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, format!("{}\n", serde_json::to_string_pretty(&val)?))?;
    Ok(path)
}

fn read_config(home_dir: &Path) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let path = config_path(home_dir);
    if !path.exists() {
        return Ok(serde_json::json!({ "layoutVersion": 1 }));
    }
    let content = fs::read_to_string(&path)?;
    Ok(serde_json::from_str(&content)?)
}

fn write_config(home_dir: &Path, config: &serde_json::Value) -> Result<(), Box<dyn std::error::Error>> {
    let path = config_path(home_dir);
    fs::write(&path, format!("{}\n", serde_json::to_string_pretty(config)?))?;
    Ok(())
}

pub fn run_keys<S: StorePort>(
    args: KeysArgs,
    engine: &mut MedhaEngine<S>,
    home_dir: &Path,
    global_json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    match args.command {
        KeysSubcommand::Generate(gen_args) => {
            let json_out = global_json || gen_args.json;
            run_generate(gen_args, home_dir, json_out)
        }
        KeysSubcommand::List(list_args) => {
            let json_out = global_json || list_args.json;
            run_list(home_dir, json_out)
        }
        KeysSubcommand::Rotate(rotate_args) => {
            let json_out = global_json || rotate_args.json;
            run_rotate(rotate_args, home_dir, json_out)
        }
        KeysSubcommand::Revoke(revoke_args) => {
            let json_out = global_json || revoke_args.json;
            run_revoke(revoke_args, home_dir, json_out)
        }
        KeysSubcommand::Verify(verify_args) => {
            let json_out = global_json || verify_args.json;
            run_verify(engine, home_dir, json_out)
        }
        KeysSubcommand::Mode(mode_args) => {
            let json_out = global_json || mode_args.json;
            run_mode(mode_args, home_dir, json_out)
        }
        KeysSubcommand::Adopt(adopt_args) => {
            let json_out = global_json || adopt_args.json;
            run_adopt(engine, json_out)
        }
    }
}

fn run_generate(
    args: KeysGenerateArgs,
    home_dir: &Path,
    json_out: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut rng = rand::rngs::OsRng;
    let signing_key = SigningKey::generate(&mut rng);
    let verifying_key = signing_key.verifying_key();
    let public_key = URL_SAFE_NO_PAD.encode(verifying_key.as_bytes());
    let key_id = key_id_for(&public_key)?;

    let priv_dir = key_dir();
    fs::create_dir_all(&priv_dir)?;
    let priv_path = private_key_path(&key_id);
    let priv_hex = hex::encode(signing_key.as_bytes());
    fs::write(&priv_path, format!("{}\n", priv_hex))?;

    let roles: Vec<KeyRole> = match args.role.as_deref() {
        Some(r) => r
            .split(',')
            .map(|s| s.trim())
            .map(|s| match s {
                "human" => KeyRole::Human,
                "maintainer" => KeyRole::Maintainer,
                _ => KeyRole::Agent,
            })
            .collect(),
        None => vec![KeyRole::Agent],
    };

    let namespaces = args.namespace.map(|ns| {
        ns.split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    });

    let mut keyring = load_keyring(home_dir)?;
    let record = KeyRecord {
        key_id: key_id.clone(),
        public_key: public_key.clone(),
        principal: args.principal.clone(),
        roles: roles.clone(),
        namespaces,
        valid_from: None,
        valid_until: None,
        revoked: None,
        supersedes: None,
        comment: args.comment,
    };
    keyring.keys.push(record);
    let keyring_p = save_keyring(home_dir, &keyring)?;

    // Update default key if requested or if first key
    let mut config = read_config(home_dir)?;
    let is_first = keyring.keys.len() == 1;
    let should_set_default = args.default || is_first;
    if should_set_default {
        let signing = config
            .as_object_mut()
            .unwrap()
            .entry("signing")
            .or_insert_with(|| serde_json::json!({ "mode": "off" }));
        signing
            .as_object_mut()
            .unwrap()
            .insert("defaultKey".to_string(), serde_json::Value::String(key_id.clone()));
        write_config(home_dir, &config)?;
    }

    if json_out {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "keyId": key_id,
                "publicKey": public_key,
                "principal": args.principal,
                "roles": roles,
                "keyringPath": keyring_p.display().to_string(),
                "privateKeyPath": priv_path.display().to_string(),
                "isDefault": should_set_default
            }))?
        );
    } else {
        println!(
            "generated {} for {} [{}]\n  public:  {}\n  private: {}",
            key_id,
            args.principal,
            roles
                .iter()
                .map(|r| match r {
                    KeyRole::Agent => "agent",
                    KeyRole::Human => "human",
                    KeyRole::Maintainer => "maintainer",
                })
                .collect::<Vec<_>>()
                .join(","),
            keyring_p.display(),
            priv_path.display()
        );
    }
    Ok(())
}

fn run_list(home_dir: &Path, json_out: bool) -> Result<(), Box<dyn std::error::Error>> {
    let keyring = load_keyring(home_dir)?;
    let config = read_config(home_dir)?;
    let signing_obj = config.get("signing");
    let mode = signing_obj
        .and_then(|s| s.get("mode"))
        .and_then(|v| v.as_str())
        .unwrap_or("off");
    let default_key = signing_obj
        .and_then(|s| s.get("defaultKey"))
        .and_then(|v| v.as_str());

    if json_out {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "mode": mode,
                "defaultKey": default_key,
                "keyring": keyring
            }))?
        );
    } else {
        println!("signing mode: {}", mode);
        if let Some(dk) = default_key {
            println!("default key:  {}", dk);
        }
        println!("\nkeyring ({} key(s)):", keyring.keys.len());
        for k in &keyring.keys {
            let status = if k.revoked.is_some() {
                " [REVOKED]"
            } else if k.valid_until.is_some() {
                " [ROTATED]"
            } else {
                ""
            };
            println!("  - {} as {}{}", k.key_id, k.principal, status);
        }
    }
    Ok(())
}

fn run_rotate(
    args: KeysRotateArgs,
    home_dir: &Path,
    json_out: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut keyring = load_keyring(home_dir)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis() as i64;

    let old_idx = keyring
        .keys
        .iter()
        .position(|k| k.key_id == args.key_id)
        .ok_or_else(|| format!("key '{}' not found in keyring", args.key_id))?;

    let old_key = keyring.keys[old_idx].clone();
    keyring.keys[old_idx].valid_until = Some(now);

    let mut rng = rand::rngs::OsRng;
    let signing_key = SigningKey::generate(&mut rng);
    let verifying_key = signing_key.verifying_key();
    let public_key = URL_SAFE_NO_PAD.encode(verifying_key.as_bytes());
    let new_key_id = key_id_for(&public_key)?;

    let priv_dir = key_dir();
    fs::create_dir_all(&priv_dir)?;
    let priv_path = private_key_path(&new_key_id);
    let priv_hex = hex::encode(signing_key.as_bytes());
    fs::write(&priv_path, format!("{}\n", priv_hex))?;

    let new_record = KeyRecord {
        key_id: new_key_id.clone(),
        public_key,
        principal: old_key.principal.clone(),
        roles: old_key.roles.clone(),
        namespaces: old_key.namespaces.clone(),
        valid_from: Some(now),
        valid_until: None,
        revoked: None,
        supersedes: Some(old_key.key_id.clone()),
        comment: old_key.comment.clone(),
    };
    keyring.keys.push(new_record);
    save_keyring(home_dir, &keyring)?;

    // Update default key if it was the old key
    let mut config = read_config(home_dir)?;
    if let Some(signing) = config.get_mut("signing") {
        if signing.get("defaultKey").and_then(|v| v.as_str()) == Some(&args.key_id) {
            signing
                .as_object_mut()
                .unwrap()
                .insert("defaultKey".to_string(), serde_json::Value::String(new_key_id.clone()));
            write_config(home_dir, &config)?;
        }
    }

    if json_out {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "retired": args.key_id,
                "keyId": new_key_id,
                "privateKeyPath": priv_path.display().to_string()
            }))?
        );
    } else {
        println!("rotated {} -> {}", args.key_id, new_key_id);
    }
    Ok(())
}

fn run_revoke(
    args: KeysRevokeArgs,
    home_dir: &Path,
    json_out: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut keyring = load_keyring(home_dir)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis() as i64;

    let idx = keyring
        .keys
        .iter()
        .position(|k| k.key_id == args.key_id)
        .ok_or_else(|| format!("key '{}' not found in keyring", args.key_id))?;

    keyring.keys[idx].revoked = Some(KeyRevocation {
        at: now,
        reason: args.reason.clone(),
        trust_before: args.trust_before,
    });
    save_keyring(home_dir, &keyring)?;

    if json_out {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "keyId": args.key_id,
                "reason": args.reason,
                "trustBefore": args.trust_before
            }))?
        );
    } else {
        println!("revoked {}", args.key_id);
    }
    Ok(())
}

fn run_verify<S: StorePort>(
    engine: &mut MedhaEngine<S>,
    home_dir: &Path,
    json_out: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let keyring = load_keyring(home_dir)?;
    let episodes = engine.store().episodes(None, None)?;
    let mut verified_count = 0;
    let mut unsigned_count = 0;
    let mut invalid_count = 0;
    let mut problems = Vec::new();

    for ep in &episodes {
        let ep_val = serde_json::to_value(ep)?;
        match verify_episode_value(&ep_val, &keyring) {
            VerifyOutcome::Verified { .. } => {
                verified_count += 1;
            }
            VerifyOutcome::Unsigned => {
                unsigned_count += 1;
            }
            VerifyOutcome::Invalid { reason, .. } => {
                invalid_count += 1;
                problems.push(serde_json::json!({
                    "seq": ep.seq,
                    "reason": reason
                }));
            }
        }
    }

    if json_out {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "total": episodes.len(),
                "verified": verified_count,
                "unsigned": unsigned_count,
                "invalid": invalid_count,
                "problems": problems
            }))?
        );
    } else {
        println!(
            "checked {} episodes: {} verified, {} unsigned, {} invalid",
            episodes.len(),
            verified_count,
            unsigned_count,
            invalid_count
        );
    }
    Ok(())
}

fn run_mode(
    args: KeysModeArgs,
    home_dir: &Path,
    json_out: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let mode = args.mode.to_lowercase();
    if mode != "off" && mode != "warn" && mode != "require" {
        return Err(format!("invalid mode '{}', expected off, warn, or require", mode).into());
    }

    let mut config = read_config(home_dir)?;
    let prev = config
        .get("signing")
        .and_then(|s| s.get("mode"))
        .and_then(|v| v.as_str())
        .unwrap_or("off")
        .to_string();

    let signing = config
        .as_object_mut()
        .unwrap()
        .entry("signing")
        .or_insert_with(|| serde_json::json!({}));
    signing
        .as_object_mut()
        .unwrap()
        .insert("mode".to_string(), serde_json::Value::String(mode.clone()));

    write_config(home_dir, &config)?;

    if json_out {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "previous": prev,
                "mode": mode
            }))?
        );
    } else {
        println!("signing mode: {} -> {}", prev, mode);
    }
    Ok(())
}

fn run_adopt<S: StorePort>(
    engine: &mut MedhaEngine<S>,
    json_out: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis() as i64;
    let report = engine.compact(now)?;
    if json_out {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "baselinesWritten": report.after_count,
                "remainingEpisodes": report.after_count,
                "beforeCount": report.before_count,
                "afterCount": report.after_count,
                "removedCount": report.removed_count,
            }))?
        );
    } else {
        println!(
            "adopted into {} baseline(s); {} episode(s) remaining",
            report.after_count, report.after_count
        );
    }
    Ok(())
}
