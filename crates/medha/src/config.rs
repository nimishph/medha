use crate::errors::MedhaError;
use medha_store::types::StoreRegistries;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const MEDHA_HOME_DIR: &str = ".medha";
pub const CONFIG_FILE: &str = "config.json";
pub const SQLITE_FILE: &str = "store.sqlite";
pub const CONFIG_LAYOUT_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum BackendKind {
    #[default]
    Sqlite,
    Memory,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MedhaConfig {
    pub layout_version: u32,
    #[serde(default)]
    pub backend: BackendKind,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub registries: StoreRegistries,
    #[serde(default)]
    pub namespace_scope: Option<Vec<String>>,
}

impl Default for MedhaConfig {
    fn default() -> Self {
        Self {
            layout_version: CONFIG_LAYOUT_VERSION,
            backend: BackendKind::Sqlite,
            path: Some(SQLITE_FILE.to_string()),
            registries: StoreRegistries::default(),
            namespace_scope: None,
        }
    }
}

impl MedhaConfig {
    pub fn load_from_file(path: impl AsRef<Path>) -> Result<Self, MedhaError> {
        let content = fs::read_to_string(path)?;
        let config: MedhaConfig = serde_json::from_str(&content)?;
        Ok(config)
    }

    pub fn save_to_file(&self, path: impl AsRef<Path>) -> Result<(), MedhaError> {
        let json = serde_json::to_string_pretty(self)?;
        if let Some(parent) = path.as_ref().parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, json)?;
        Ok(())
    }

    pub fn find_home(start_dir: impl AsRef<Path>) -> Option<PathBuf> {
        let mut curr = start_dir.as_ref().to_path_buf();
        loop {
            let candidate = curr.join(MEDHA_HOME_DIR);
            if candidate.is_dir() && candidate.join(CONFIG_FILE).is_file() {
                return Some(candidate);
            }
            if !curr.pop() {
                break;
            }
        }
        None
    }
}
