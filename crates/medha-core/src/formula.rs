use crate::drift::compute_drift;
use crate::durability::durability_factor;
use crate::guard::{guard_factor, is_guarded};
use crate::recency::recency_factor;
use crate::round::round6;
use crate::types::{
    CoreError, EmaState, Evidence, GuardState, KindConvergenceGates, LifecycleStatus, RecencyConfig, Thresholds,
    TrustScoreBreakdown,
};
use crate::wilson::{wilson_lower_bound, wilson_upper_bound};

pub struct TrustComputationInput<'a> {
    pub evidence: &'a Evidence,
    pub guard: &'a GuardState,
    pub distinct_anchor_count: usize,
    pub ema: &'a EmaState,
    pub last_signal_at: Option<i64>,
    pub now: i64,
    pub stored_status: LifecycleStatus,
    pub status_override: Option<LifecycleStatus>,
    pub thresholds: &'a Thresholds,
    pub recency_config: &'a RecencyConfig,
    /// Distinct authors of the failed trials, when the caller tracks them. `None` (not tracked)
    /// satisfies a `min_distinct_authors_for_retired` of 1 and no higher.
    pub rejecting_authors: Option<usize>,
    /// Distinct agent roles observed among successes (medha-c8z.3).
    pub observed_roles: Option<&'a [String]>,
    /// Kind convergence gates for multi-agent validation (medha-c8z.3).
    pub convergence_gates: Option<&'a KindConvergenceGates>,
}

pub struct TrustComputationResult {
    pub trust: f64,
    pub status: LifecycleStatus,
    pub breakdown: TrustScoreBreakdown,
}

pub fn compute_trust_and_status(
    input: TrustComputationInput,
) -> Result<TrustComputationResult, CoreError> {
    let k = input.evidence.k;
    let n = input.evidence.n;
    // Floor, not round: the thresholds are integer minimums on a possibly fractional `n`
    // (signal-value weighting), and `n >= T` holds exactly when `floor(n) >= T`. Rounding would
    // count n = 2.8 as 3 trials and retire or drift-check a rule the TypeScript kernel leaves alone.
    let trials_u64 = n.floor() as u64;

    let guarded = is_guarded(input.guard);
    let l = wilson_lower_bound(k, n, crate::thresholds::WILSON_Z)?;
    let u = wilson_upper_bound(k, n, crate::thresholds::WILSON_Z)?;
    let g = guard_factor(input.guard);
    let r = recency_factor(input.last_signal_at, input.now, input.recency_config)?;
    let d = durability_factor(input.distinct_anchor_count, guarded)?;

    let drift = compute_drift(trials_u64, input.ema.mu, input.ema.theta0)?;

    let ceiling = if guarded {
        1.0
    } else {
        input.thresholds.unguarded_ceiling
    };

    let raw = l * g * r * d;
    let mut t = round6(raw.min(ceiling).clamp(0.0, 1.0))?;

    // Invariant: unguarded entity must be strictly below its ceiling
    if !guarded && t >= ceiling {
        t = round6(ceiling - 1e-6)?;
    }

    // Terminal statuses zero trust; their components are still reported, with durability 1
    // (spec §5, "Terminal statuses").
    let terminal = input.stored_status == LifecycleStatus::Quarantined
        || input.stored_status == LifecycleStatus::Retired;
    if terminal {
        t = 0.0;
    }

    let enough_rejecting_authors = input.thresholds.min_distinct_authors_for_retired <= 1
        || input.rejecting_authors.unwrap_or(0) as u64
            >= input.thresholds.min_distinct_authors_for_retired;
    let status = derive_status(
        input.status_override,
        input.stored_status,
        input.guard,
        drift.is_drifting_down,
        trials_u64,
        l,
        g,
        t,
        input.thresholds,
        enough_rejecting_authors,
        input.observed_roles,
        input.convergence_gates,
    );

    let breakdown = TrustScoreBreakdown {
        score: t,
        wilson_lower: l,
        wilson_upper: u,
        recency: r,
        durability: if terminal { 1.0 } else { d },
        guard_factor: g,
        effective_ceiling: ceiling,
        is_drifting: drift.is_drifting,
        drift_direction: drift.direction,
    };

    Ok(TrustComputationResult {
        trust: t,
        status,
        breakdown,
    })
}

// Mirrors the spec §6 status derivation, whose inputs are separate state fields.
#[allow(clippy::too_many_arguments)]
fn derive_status(
    status_override: Option<LifecycleStatus>,
    stored_status: LifecycleStatus,
    guard: &GuardState,
    is_drifting_down: bool,
    trials: u64,
    l: f64,
    g: f64,
    t: f64,
    thresholds: &Thresholds,
    enough_rejecting_authors: bool,
    observed_roles: Option<&[String]>,
    convergence_gates: Option<&KindConvergenceGates>,
) -> LifecycleStatus {
    // 1. Explicit override
    if let Some(over) = status_override {
        if over == LifecycleStatus::Retired || over == LifecycleStatus::Quarantined {
            return over;
        }
    }

    // 2. Stored retired stays retired
    if stored_status == LifecycleStatus::Retired {
        return LifecycleStatus::Retired;
    }

    // 3. Guard failed
    let guarded = is_guarded(guard);
    if guarded && guard.last_ok == Some(false) {
        return LifecycleStatus::Quarantined;
    }

    // 4. Drifting downward
    if is_drifting_down {
        return LifecycleStatus::Quarantined;
    }

    // 5. Status for trust
    // 5.1 Retirement threshold check (undecayed product L * G), from enough distinct authors
    if trials >= thresholds.min_uses_for_retired
        && (l * g) < thresholds.retired_trust_threshold
        && enough_rejecting_authors
    {
        return LifecycleStatus::Retired;
    }

    // 5.2 Trusted threshold check
    let passes_trusted_gates = match convergence_gates {
        Some(gates) => {
            let min_roles = gates.min_distinct_roles_for_trusted.unwrap_or(1);
            let role_count = observed_roles.map(|r| r.len()).unwrap_or(0);
            let has_enough_roles = role_count >= min_roles;
            let has_required_roles = match &gates.required_roles_for_trusted {
                Some(reqs) => reqs.iter().all(|req| {
                    observed_roles
                        .map(|roles| roles.iter().any(|r| r == req))
                        .unwrap_or(false)
                }),
                None => true,
            };
            has_enough_roles && has_required_roles
        }
        None => true,
    };

    if t >= thresholds.trusted
        && trials >= thresholds.min_uses_for_trusted
        && guarded
        && guard.last_ok == Some(true)
        && passes_trusted_gates
    {
        return LifecycleStatus::Trusted;
    }

    // 5.3 Active threshold check
    let passes_active_gates = match convergence_gates {
        Some(gates) => match gates.min_distinct_roles_for_active {
            Some(min_roles) => observed_roles.map(|r| r.len()).unwrap_or(0) >= min_roles,
            None => true,
        },
        None => true,
    };

    if t >= thresholds.active && passes_active_gates {
        return LifecycleStatus::Active;
    }

    // 5.4 Probation default
    LifecycleStatus::Probation
}
