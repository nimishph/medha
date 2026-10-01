use thiserror::Error;

#[derive(Error, Debug, PartialEq)]
pub enum StoreError {
    #[error("Store is closed when attempting {0}")]
    StoreClosed(&'static str),

    #[error("Cannot perform operation on corrupt store at {store_path} (corrupt at seq {at_seq}): {reason}")]
    CorruptStore {
        store_path: String,
        at_seq: u64,
        reason: String,
    },

    #[error("Store layout version {found} is newer than supported layout {supported}")]
    StoreLayout { found: u32, supported: u32 },

    #[error("Database error: {0}")]
    Database(String),

    #[error("Serialization error: {0}")]
    Serialization(String),

    #[error("Invalid argument for '{name}': {reason}")]
    InvalidArgument {
        name: &'static str,
        reason: String,
    },

    #[error("Core error: {0}")]
    Core(#[from] medha_core::types::CoreError),
}

impl From<rusqlite::Error> for StoreError {
    fn from(err: rusqlite::Error) -> Self {
        StoreError::Database(err.to_string())
    }
}

impl From<serde_json::Error> for StoreError {
    fn from(err: serde_json::Error) -> Self {
        StoreError::Serialization(err.to_string())
    }
}
