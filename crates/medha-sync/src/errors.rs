use thiserror::Error;

#[derive(Error, Debug)]
pub enum SyncError {
    #[error("Store error: {0}")]
    Store(#[from] medha_store::errors::StoreError),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON serialization error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Schema version mismatch: expected {expected}, found {found}")]
    SchemaVersionMismatch { expected: u32, found: u32 },

    #[error("Invalid snapshot: {0}")]
    InvalidSnapshot(String),

    #[error("Git execution error: {0}")]
    Git(String),

    #[error("Sync diverged: {0}")]
    Diverged(String),

    #[error("Not a git repository: {0}")]
    NotAGitRepository(String),
}
