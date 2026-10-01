pub mod config;
pub mod engine;
pub mod errors;
pub mod maintenance;

pub use config::{
    BackendKind, MedhaConfig, CONFIG_FILE, CONFIG_LAYOUT_VERSION, MEDHA_HOME_DIR, SQLITE_FILE,
};
pub use engine::{
    ConditionStatus, GateExplanation, GuardInput, MedhaEngine, RecordInput, ShowReport,
    SimulationReport, ThresholdExplanation,
};
pub use errors::MedhaError;
pub use maintenance::{CompactionReport, PreflightReport, SweepChange, SweepOptions, SweepReport};

// Re-export underlying foundational layers
pub use medha_core as core;
pub use medha_store as store;
pub use medha_sync as sync;
