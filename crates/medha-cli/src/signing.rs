//! Episode signing for a home (medha-nwf.4), as the TypeScript engine does it (`Medha#sign`,
//! `loadSigner`, `admitFilter`): with a signer every outgoing episode is signed, an absent author
//! becomes the key's principal and a different author is refused; in `require` mode an episode must
//! verify to be written, and only verified episodes count when the log is folded.

use std::path::{Path, PathBuf};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use ed25519_dalek::{Signer as _, SigningKey};
use medha::core::signing::{
    author_matches_principal, key_id_for, signing_payload_for_value, validate_keyring,
    verify_episode_value, Keyring, VerifyOutcome,
};
use medha::store::StoreError;
use serde_json::{json, Value};

use crate::failure::Failure;

/// Set once a home with a signer is opened: the author then defaults to the key's principal, not
/// to `$MEDHA_AUTHOR` / `$USER` (TypeScript `resolveAuthor(..., signing)`).
pub static SIGNING_ACTIVE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

pub struct Signer {
    pub key_id: String,
    key: SigningKey,
}

impl Signer {
    /// Sign a serialized episode (with or without `seq`); `signable_value` drops `seq` and `sig`.
    pub fn sign_value(&self, episode: &mut Value) -> Result<(), StoreError> {
        let payload = signing_payload_for_value(episode)
            .map_err(|e| StoreError::Serialization(e.to_string()))?;
        let sig = self.key.sign(&payload);
        episode["sig"] = json!({
            "keyId": self.key_id,
            "value": URL_SAFE_NO_PAD.encode(sig.to_bytes()),
        });
        Ok(())
    }
}

/// The home's signing policy and signer.
pub struct Policy {
    pub mode: String,
    pub keyring: Keyring,
    pub signer: Option<Signer>,
}

impl Policy {
    pub fn principal(&self) -> Option<String> {
        let signer = self.signer.as_ref()?;
        self.keyring
            .keys
            .iter()
            .find(|k| k.key_id == signer.key_id)
            .map(|k| k.principal.clone())
    }

    pub fn require(&self) -> bool {
        self.mode == "require"
    }

    /// Why an episode does not verify, or `None` when it does.
    pub fn rejection(&self, episode: &Value) -> Option<String> {
        match verify_episode_value(episode, &self.keyring) {
            VerifyOutcome::Verified { .. } => None,
            VerifyOutcome::Unsigned => Some("unsigned".to_string()),
            VerifyOutcome::Invalid { reason, .. } => Some(reason),
        }
    }

    pub fn verified(&self, episode: &Value) -> bool {
        matches!(
            verify_episode_value(episode, &self.keyring),
            VerifyOutcome::Verified { .. }
        )
    }

    /// Fill or check the author, sign, and in `require` mode refuse what would not verify.
    pub fn sign_outgoing(&self, episode: &mut Value) -> Result<(), StoreError> {
        let action = action_for(episode["type"].as_str().unwrap_or(""));
        if let Some(signer) = &self.signer {
            if let Some(principal) = self.principal() {
                match episode["author"].as_str() {
                    None => episode["author"] = json!(principal),
                    Some(a) if !author_matches_principal(Some(a), &principal) => {
                        return Err(StoreError::PermissionDenied {
                            action,
                            reason: format!(
                                "author '{a}' is not the signing key's principal '{principal}' (or '{principal}/<label>')"
                            ),
                            hint: None,
                        });
                    }
                    Some(_) => {}
                }
            }
            signer.sign_value(episode)?;
        }
        if self.require() {
            match verify_episode_value(episode, &self.keyring) {
                VerifyOutcome::Verified { .. } => {}
                outcome => {
                    return Err(StoreError::PermissionDenied {
                        action,
                        reason: match outcome {
                            VerifyOutcome::Unsigned => {
                                "signing mode is 'require' and no signing key is configured"
                                    .to_string()
                            }
                            VerifyOutcome::Invalid { reason, .. } => {
                                format!("the episode would not verify: {reason}")
                            }
                            VerifyOutcome::Verified { .. } => String::new(),
                        },
                        hint: Some(
                            "Configure a signing key registered in the keyring (medha keys)."
                                .to_string(),
                        ),
                    });
                }
            }
        }
        Ok(())
    }
}

fn action_for(episode_type: &str) -> String {
    match episode_type {
        "signal" => "record",
        "guard" => "reportGuard",
        "proposal" => "propose",
        other => other,
    }
    .to_string()
}

/// Where `medha keys` keeps private keys (`MEDHA_KEY_DIR`, else the per-user config directory).
pub fn private_key_path(key_id: &str) -> PathBuf {
    crate::keys::private_key_path_for(key_id)
}

/// A private key file: the hex seed this CLI writes, or the PKCS#8 PEM the TypeScript CLI writes.
fn parse_private_key(text: &str) -> Option<SigningKey> {
    let t = text.trim();
    if t.contains("-----BEGIN") {
        let body: String = t
            .lines()
            .filter(|l| !l.starts_with("-----"))
            .collect::<Vec<_>>()
            .join("");
        let der = base64::engine::general_purpose::STANDARD
            .decode(body)
            .ok()?;
        // An Ed25519 PKCS#8 v1 key ends with the 32-byte seed.
        let seed: [u8; 32] = der.get(der.len().checked_sub(32)?..)?.try_into().ok()?;
        return Some(SigningKey::from_bytes(&seed));
    }
    let bytes = hex::decode(t).ok()?;
    let seed: [u8; 32] = bytes.get(..32)?.try_into().ok()?;
    Some(SigningKey::from_bytes(&seed))
}

fn signer_from_key(key: SigningKey) -> Result<Signer, Failure> {
    let public = URL_SAFE_NO_PAD.encode(key.verifying_key().as_bytes());
    let key_id =
        key_id_for(&public).map_err(|e| Failure::invalid("signing key", "a valid key", e))?;
    Ok(Signer { key_id, key })
}

/// The home's policy: `signing.mode` and the keyring, and the signer (`MEDHA_SIGNING_KEY`, a PEM
/// or hex key or a path to one, wins over `signing.defaultKey`).
pub fn policy_for(home: &Path, config_raw: &Value) -> Result<Policy, Failure> {
    let mode = config_raw["signing"]["mode"]
        .as_str()
        .unwrap_or("off")
        .to_string();
    let ring_path = home.join("keys").join("keyring.json");
    let keyring = match std::fs::read_to_string(&ring_path) {
        Ok(text) => {
            let raw: Value = serde_json::from_str(&text)
                .map_err(|_| Failure::invalid("keyring", "valid JSON", ring_path.display()))?;
            validate_keyring(&raw).map_err(|e| Failure::invalid("keyring", "a valid keyring", e))?
        }
        Err(_) => Keyring::default(),
    };
    let signer = match std::env::var("MEDHA_SIGNING_KEY")
        .ok()
        .filter(|v| !v.trim().is_empty())
    {
        Some(v) => {
            let text = if v.contains("-----BEGIN") || hex::decode(v.trim()).is_ok() {
                v
            } else {
                std::fs::read_to_string(v.trim()).map_err(|_| {
                    Failure::invalid("signing key", "a PEM key or a path to one", &v)
                })?
            };
            let key = parse_private_key(&text).ok_or_else(|| {
                Failure::invalid("signing key", "an Ed25519 private key", "MEDHA_SIGNING_KEY")
            })?;
            Some(signer_from_key(key)?)
        }
        None => match config_raw["signing"]["defaultKey"].as_str() {
            None => None,
            Some(id) => {
                let path = private_key_path(id);
                let text = std::fs::read_to_string(&path).map_err(|_| {
                    Failure::invalid(
                        "signing key",
                        &format!("a private key file at {}", path.display()),
                        id,
                    )
                    .with_hint("Generate one with `medha keys generate`, or set MEDHA_SIGNING_KEY.")
                })?;
                let key = parse_private_key(&text)
                    .ok_or_else(|| Failure::invalid("signing key", "an Ed25519 private key", id))?;
                let signer = signer_from_key(key)?;
                if signer.key_id != id {
                    return Err(Failure::invalid(
                        "signing key",
                        &format!("the private key for {id}"),
                        signer.key_id,
                    ));
                }
                Some(signer)
            }
        },
    };
    Ok(Policy {
        mode,
        keyring,
        signer,
    })
}
