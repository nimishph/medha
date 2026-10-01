use thiserror::Error;

#[derive(Error, Debug)]
pub enum MedhaError {
    #[error("Core error: {0}")]
    Core(#[from] medha_core::types::CoreError),

    #[error("Store error: {0}")]
    Store(#[from] medha_store::errors::StoreError),

    #[error("Sync error: {0}")]
    Sync(#[from] medha_sync::errors::SyncError),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Config error: {0}")]
    Config(String),

    #[error("Entity '{0}' not found")]
    NotFound(String),

    #[error("Invalid argument for '{name}': {reason}")]
    InvalidArgument { name: &'static str, reason: String },

    #[error("Permission denied: {0}")]
    PermissionDenied(String),
}
