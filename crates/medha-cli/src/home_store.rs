//! The store an engine home commits to, as the TypeScript `storeForConfig` + `scopeStore` build it:
//! SQLite or the file document (`FilePolicyStore`), optionally restricted to the home's
//! `namespaceScope`. One type, so every command runs on the same `MedhaEngine<HomeStore>`.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use medha::store::{
    AppendResult, EntityKey, EntityState, Episode, EpisodeInput, EpisodePayload, MemoryStore,
    OpenResult, ReplaceLogResult, SqliteStore, SqliteStoreOptions, StoreError, StorePort,
    StoreRegistries,
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

fn corrupt(path: &Path, reason: &str) -> StoreError {
    StoreError::CorruptStore {
        store_path: path.display().to_string(),
        at_seq: 0,
        reason: reason.to_string(),
    }
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
        let text = fs::read_to_string(&self.path).map_err(io)?;
        let doc: Value = serde_json::from_str(&text)
            .map_err(|_| corrupt(&self.path, "not a valid store document"))?;
        if doc["layoutVersion"].as_u64().is_some_and(|v| v > 1) {
            return Err(StoreError::StoreLayout {
                found: doc["layoutVersion"].as_u64().unwrap_or(0) as u32,
                supported: 1,
            });
        }
        let Some(raw) = doc["episodes"].as_array() else {
            return Err(corrupt(&self.path, "the document has no episode log"));
        };
        let episodes: Vec<Episode> = raw
            .iter()
            .map(|e| serde_json::from_value(e.clone()))
            .collect::<Result<_, _>>()
            .map_err(|_| corrupt(&self.path, "an episode could not be read"))?;
        self.inner.replace_log(&episodes)?;
        if let Some(meta) = doc["meta"].as_object() {
            for (k, v) in meta {
                if let Some(v) = v.as_str() {
                    self.meta.insert(k.clone(), v.to_string());
                    self.inner.set_meta(k, v)?;
                }
            }
        }
        Ok(OpenResult::Ok)
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
        }
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
        self.port().get(key)
    }
    fn list(&self) -> Result<Vec<EntityState>, StoreError> {
        Ok(self
            .port()
            .list()?
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
