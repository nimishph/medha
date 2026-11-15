pub mod decision;
pub mod drift;
pub mod durability;
pub mod fold;
pub mod formula;
pub mod guard;
pub mod packer;
pub mod recency;
pub mod round;
pub mod signing;
pub mod thresholds;
pub mod types;
pub mod wilson;

pub use decision::{
    is_human_author, score_decision_case, Decision, DecisionCase, ScoredDecisionCase,
};
pub use drift::{compute_drift, ema_step, DriftReport};
pub use durability::{durability_factor, raw_durability_factor};
pub use fold::{
    bound_authors_ledger, canonical_signals, fold_guard_step, fold_signal_step, signal_limit_key,
    AuthorLedger, EntityFoldState, KindSpec, SignalLimits, MAX_AUTHORS_PER_ENTITY,
};
pub use formula::{compute_trust_and_status, TrustComputationInput, TrustComputationResult};
pub use guard::{guard_factor, is_guarded};
pub use packer::{
    pack_entities, Mulberry32, PackCandidate, PackOutcome, PackPolicy, PackedEntity,
    DEFAULT_EXPLORATION_RATIO,
};
pub use recency::recency_factor;
pub use round::round6;
pub use thresholds::*;
pub use types::*;
pub use wilson::{
    default_wilson_lower, default_wilson_upper, default_wilson_width, wilson_lower_bound,
    wilson_upper_bound, wilson_width,
};
