//! The store an engine home commits to, as the TypeScript `storeForConfig` + `scopeStore` build it:
//! SQLite or the file document (`FilePolicyStore`), optionally restricted to the home's
//! `namespaceScope`. One type, so every command runs on the same `MedhaEngine<HomeStore>`.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use medha::store::{
    AppendResult, CorruptLocation, EntityKey, EntityState, Episode, EpisodeInput, EpisodePayload,
    MemoryStore, OpenResult, ReplaceLogResult, SqliteStore, SqliteStoreOptions, StoreError,
    StorePort, StoreRegistries,
};
use serde_json::{json, Value};

/// The file backend: one JSON document (`{layoutVersion, registries, episodes, meta}`), rewritten
/// atomically on every change (temp file, previous document kept as `.bak`, rename).
pub struct FileDocStore {
    path: PathBuf,
    inner: MemoryStore,
    meta: BTreeMap<String, String>,
}

impl FileDocStore {
    pub fn new(path: PathBuf, registries: StoreRegistries) -> Self {
        Self {
            path,
            inner: MemoryStore::new(Some(registries)),
            meta: BTreeMap::new(),
        }
    }

    fn persist(&self) -> Result<(), StoreError> {
        let doc = json!({
            "layoutVersion": 1,
            "registries": self.inner.registries(),
            "episodes": self.inner.episodes(None, None)?,
            "meta": self.meta,
        });
        let text = format!("{}\n", serde_json::to_string_pretty(&doc)?);
        let tmp = with_suffix(&self.path, ".tmp");
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(io)?;
        }
        fs::write(&tmp, text).map_err(io)?;
        if self.path.exists() {
            fs::copy(&self.path, with_suffix(&self.path, ".bak")).map_err(io)?;
        }
        fs::rename(&tmp, &self.path).map_err(io)?;
        Ok(())
    }
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

fn io(e: std::io::Error) -> StoreError {
    StoreError::Database(e.to_string())
}

impl StorePort for FileDocStore {
    fn name(&self) -> &'static str {
        "file"
    }
    fn registries(&self) -> &StoreRegistries {
        self.inner.registries()
    }
    fn set_registries(&mut self, registries: StoreRegistries) {
        self.inner.set_registries(registries);
    }
    fn is_open(&self) -> bool {
        self.inner.is_open()
    }
    fn open(&mut self) -> Result<OpenResult, StoreError> {
        self.inner.open()?;
        if !self.path.exists() {
            return Ok(OpenResult::Ok);
        }
        // A document that cannot be read, or a log that breaks, opens as corrupt (as the TypeScript
        // FilePolicyStore does): the readable prefix is loaded, reads refuse to answer from it, and
        // preflight reports where it broke instead of the command failing outright.
        let text = fs::read_to_string(&self.path).map_err(io)?;
        let source = self.path.display().to_string();
        let corrupt_at = |at_seq: u64| OpenResult::Corrupt {
            location: CorruptLocation {
                source: source.clone(),
                at_seq,
            },
        };
        let Ok(doc) = serde_json::from_str::<Value>(&text) else {
            return Ok(corrupt_at(0));
        };
        if doc["layoutVersion"].as_u64().is_some_and(|v| v > 1) {
            return Err(StoreError::StoreLayout {
                found: doc["layoutVersion"].as_u64().unwrap_or(0) as u32,
                supported: 1,
            });
        }
        let Some(raw) = doc["episodes"].as_array() else {
            return Ok(corrupt_at(0));
        };
        let mut episodes: Vec<Episode> = Vec::new();
        let mut broke_at = None;
        for (i, e) in raw.iter().enumerate() {
            match serde_json::from_value::<Episode>(e.clone()) {
                Ok(ep) if ep.seq == i as u64 => episodes.push(ep),
                _ => {
                    broke_at = Some(i as u64);
                    break;
                }
            }
        }
        if self.inner.replace_log(&episodes).is_err() {
            return Ok(corrupt_at(0));
        }
        if let Some(meta) = doc["meta"].as_object() {
            for (k, v) in meta {
                if let Some(v) = v.as_str() {
                    self.meta.insert(k.clone(), v.to_string());
                    self.inner.set_meta(k, v)?;
                }
            }
        }
        Ok(match broke_at {
            Some(seq) => corrupt_at(seq),
            None => OpenResult::Ok,
        })
    }
    fn close(&mut self) -> Result<(), StoreError> {
        self.inner.close()
    }
    fn append(&mut self, input: EpisodeInput) -> Result<AppendResult, StoreError> {
        let r = self.inner.append(input)?;
        self.persist()?;
        Ok(r)
    }
    fn episodes(
        &self,
        after_seq: Option<i64>,
        limit: Option<usize>,
    ) -> Result<Vec<Episode>, StoreError> {
        self.inner.episodes(after_seq, limit)
    }
    fn get(&self, key: &EntityKey) -> Result<Option<EntityState>, StoreError> {
        self.inner.get(key)
    }
    fn list(&self) -> Result<Vec<EntityState>, StoreError> {
        self.inner.list()
    }
    fn rebuild(&mut self) -> Result<Vec<EntityState>, StoreError> {
        self.inner.rebuild()
    }
    fn replace_log(&mut self, episodes: &[Episode]) -> Result<ReplaceLogResult, StoreError> {
        let r = self.inner.replace_log(episodes)?;
        self.persist()?;
        Ok(r)
    }
    fn get_meta(&self, key: &str) -> Result<Option<String>, StoreError> {
        Ok(self.meta.get(key).cloned())
    }
    fn set_meta(&mut self, key: &str, value: &str) -> Result<(), StoreError> {
        self.meta.insert(key.to_string(), value.to_string());
        self.inner.set_meta(key, value)?;
        self.persist()
    }
}

pub enum Backend {
    Sqlite(SqliteStore),
    File(FileDocStore),
}

/// The home's store, optionally scoped to its namespaces. A scoped store hides other namespaces
/// from reads and refuses writes into them (TypeScript `scopeStore`).
pub struct HomeStore {
    backend: Backend,
    scope: Option<Vec<String>>,
    signing: Option<crate::signing::Policy>,
}

impl HomeStore {
    pub fn sqlite(path: &Path, registries: StoreRegistries) -> Self {
        Self::of(Backend::Sqlite(SqliteStore::new(SqliteStoreOptions {
            path: path.to_string_lossy().to_string(),
            registries: Some(registries),
            resilient_replay: false,
        })))
    }

    pub fn file(path: &Path, registries: StoreRegistries) -> Self {
        Self::of(Backend::File(FileDocStore::new(
            path.to_path_buf(),
            registries,
        )))
    }

    fn of(backend: Backend) -> Self {
        Self {
            backend,
            scope: None,
            signing: None,
        }
    }

    /// Sign outgoing episodes with the home's key, and under `require` count only verified ones.
    pub fn signed(mut self, policy: crate::signing::Policy) -> Self {
        self.signing = Some(policy);
        self
    }

    /// Refuse `keys adopt` without a signer, before anything is compacted.
    pub fn require_signer(&self) -> Result<(), StoreError> {
        match self.signing.as_ref().and_then(|p| p.signer.as_ref()) {
            Some(_) => Ok(()),
            None => Err(StoreError::PermissionDenied {
                action: "adopt".to_string(),
                reason: "no signing key is configured".to_string(),
                hint: None,
            }),
        }
    }

    /// Sign the unsigned baselines in the log (after `keys adopt` compacted it) with this home's
    /// key, so `require` mode counts them; each must verify (the key needs the maintainer role).
    /// Returns how many were signed.
    pub fn sign_baselines(&mut self) -> Result<usize, StoreError> {
        self.require_signer()?;
        let policy = self.signing.as_ref().expect("checked above");
        let mut log = self.port().episodes(None, None)?;
        let mut signed = 0;
        for episode in log.iter_mut() {
            if !matches!(episode.payload, EpisodePayload::Baseline { .. }) || episode.sig.is_some()
            {
                continue;
            }
            let mut value = serde_json::to_value(&*episode)?;
            // As TypeScript `sign`: the author becomes the key's principal, then it is signed.
            policy.sign_outgoing(&mut value)?;
            if let Some(reason) = policy.rejection(&value) {
                return Err(StoreError::PermissionDenied {
                    action: "adopt".to_string(),
                    reason: format!("the baselines would not verify: {reason}"),
                    hint: Some(
                        "Adoption needs a key with the maintainer role in the keyring.".to_string(),
                    ),
                });
            }
            *episode = serde_json::from_value(value)?;
            signed += 1;
        }
        if signed > 0 {
            self.port_mut().replace_log(&log)?;
        }
        Ok(signed)
    }

    /// The require-mode policy, when reads must fold only verified episodes.
    fn requiring(&self) -> Option<&crate::signing::Policy> {
        self.signing.as_ref().filter(|p| p.require())
    }

    /// Entity states folded from the verified episodes only (TypeScript `admitFilter`).
    fn verified_states(&self) -> Result<Vec<EntityState>, StoreError> {
        let Some(policy) = self.requiring() else {
            return Ok(Vec::new());
        };
        let episodes = self.port().episodes(None, None)?;
        let admit = |e: &Episode| {
            serde_json::to_value(e)
                .map(|v| policy.verified(&v))
                .unwrap_or(false)
        };
        let folded = medha::store::fold_log_filtered(
            &episodes,
            Some(self.port().registries()),
            Some(&admit),
        );
        let mut states: Vec<EntityState> = folded.into_values().collect();
        states.sort_by_key(|s| s.key.to_string_repr());
        Ok(states)
    }

    /// Restrict to these namespaces; `None` or an empty list leaves the store unrestricted.
    pub fn scoped(mut self, scope: Option<Vec<String>>) -> Self {
        self.scope = scope.filter(|s| !s.is_empty()).map(|mut s| {
            s.sort();
            s.dedup();
            s
        });
        self
    }

    fn port(&self) -> &dyn StorePort {
        match &self.backend {
            Backend::Sqlite(s) => s,
            Backend::File(f) => f,
        }
    }

    fn port_mut(&mut self) -> &mut dyn StorePort {
        match &mut self.backend {
            Backend::Sqlite(s) => s,
            Backend::File(f) => f,
        }
    }

    fn in_scope(&self, key: &EntityKey) -> bool {
        self.scope
            .as_ref()
            .is_none_or(|s| s.contains(&key.namespace))
    }

    fn check(&self, action: &str, key: &EntityKey) -> Result<(), StoreError> {
        match &self.scope {
            Some(allowed) if !allowed.contains(&key.namespace) => {
                Err(StoreError::NamespaceViolation {
                    action: action.to_string(),
                    namespace: key.namespace.clone(),
                    allowed: allowed.clone(),
                })
            }
            _ => Ok(()),
        }
    }
}

impl StorePort for HomeStore {
    fn name(&self) -> &'static str {
        self.port().name()
    }
    fn registries(&self) -> &StoreRegistries {
        self.port().registries()
    }
    fn set_registries(&mut self, registries: StoreRegistries) {
        self.port_mut().set_registries(registries);
    }
    fn is_open(&self) -> bool {
        self.port().is_open()
    }
    fn open(&mut self) -> Result<OpenResult, StoreError> {
        self.port_mut().open()
    }
    fn close(&mut self) -> Result<(), StoreError> {
        self.port_mut().close()
    }
    fn append(&mut self, input: EpisodeInput) -> Result<AppendResult, StoreError> {
        self.check("append", &input.key)?;
        if let EpisodePayload::Retract { target_seq, .. } = &input.payload {
            if let Some(target) = self
                .port()
                .episodes(None, None)?
                .into_iter()
                .find(|e| e.seq == *target_seq)
            {
                self.check("append (retract target)", &target.key)?;
            }
        }
        let input = match &self.signing {
            Some(policy) => {
                let mut value = serde_json::to_value(&input)?;
                policy.sign_outgoing(&mut value)?;
                serde_json::from_value(value)?
            }
            None => input,
        };
        self.port_mut().append(input)
    }
    fn episodes(
        &self,
        after_seq: Option<i64>,
        limit: Option<usize>,
    ) -> Result<Vec<Episode>, StoreError> {
        if self.scope.is_none() {
            return self.port().episodes(after_seq, limit);
        }
        let visible: Vec<Episode> = self
            .port()
            .episodes(after_seq, None)?
            .into_iter()
            .filter(|e| self.in_scope(&e.key))
            .collect();
        Ok(match limit {
            Some(l) => visible.into_iter().take(l).collect(),
            None => visible,
        })
    }
    fn get(&self, key: &EntityKey) -> Result<Option<EntityState>, StoreError> {
        self.check("get", key)?;
        if self.requiring().is_some() {
            let repr = key.to_string_repr();
            return Ok(self
                .verified_states()?
                .into_iter()
                .find(|s| s.key.to_string_repr() == repr));
        }
        self.port().get(key)
    }
    fn list(&self) -> Result<Vec<EntityState>, StoreError> {
        let states = if self.requiring().is_some() {
            self.verified_states()?
        } else {
            self.port().list()?
        };
        Ok(states
            .into_iter()
            .filter(|s| self.in_scope(&s.key))
            .collect())
    }
    fn rebuild(&mut self) -> Result<Vec<EntityState>, StoreError> {
        let all = self.port_mut().rebuild()?;
        Ok(all.into_iter().filter(|s| self.in_scope(&s.key)).collect())
    }
    fn replace_log(&mut self, episodes: &[Episode]) -> Result<ReplaceLogResult, StoreError> {
        self.port_mut().replace_log(episodes)
    }
    fn get_meta(&self, key: &str) -> Result<Option<String>, StoreError> {
        self.port().get_meta(key)
    }
    fn set_meta(&mut self, key: &str, value: &str) -> Result<(), StoreError> {
        self.port_mut().set_meta(key, value)
    }
}
