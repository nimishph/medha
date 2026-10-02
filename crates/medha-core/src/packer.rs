use crate::round::round6;
use crate::types::{CoreError, EntityKey, LifecycleStatus, TrustHint};
use crate::wilson::default_wilson_width;
use serde::{Deserialize, Serialize};

pub const DEFAULT_EXPLORATION_RATIO: f64 = 0.15;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackCandidate {
    pub key: EntityKey,
    pub hint: TrustHint,
    pub cost: usize,
    #[serde(default)]
    pub mandatory: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackPolicy {
    pub budget: usize,
    #[serde(default = "default_exploration_ratio")]
    pub exploration_ratio: f64,
    pub seed: Option<u64>,
    #[serde(default)]
    pub min_trust: f64,
    #[serde(default)]
    pub allow_quarantined: bool,
    #[serde(default)]
    pub allow_retired: bool,
}

fn default_exploration_ratio() -> f64 {
    DEFAULT_EXPLORATION_RATIO
}

impl Default for PackPolicy {
    fn default() -> Self {
        Self {
            budget: 0,
            exploration_ratio: DEFAULT_EXPLORATION_RATIO,
            seed: None,
            min_trust: 0.0,
            allow_quarantined: false,
            allow_retired: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackedEntity {
    pub key: EntityKey,
    pub hint: TrustHint,
    pub cost: usize,
    #[serde(rename = "admittedBy")]
    pub admitted_by: String, // "mandatory" | "probation" | "merit"
    pub density: f64,
    pub uncertainty: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackOutcome {
    pub selected: Vec<PackedEntity>,
    pub rejected: Vec<PackCandidate>,
    pub budget: usize,
    #[serde(rename = "totalCost")]
    pub total_cost: usize,
    #[serde(rename = "remainingBudget")]
    pub remaining_budget: usize,
    pub utilization: f64,
    #[serde(rename = "mandatoryCount")]
    pub mandatory_count: usize,
    #[serde(rename = "probationCount")]
    pub probation_count: usize,
    #[serde(rename = "meritCount")]
    pub merit_count: usize,
}

/// Mulberry32 deterministic 32-bit PRNG returning float in [0, 1)
pub struct Mulberry32 {
    state: u32,
}

impl Mulberry32 {
    pub fn new(seed: u64) -> Self {
        Self { state: seed as u32 }
    }

    pub fn next_f64(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6d2b79f5);
        let mut t = self.state;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        let val = (t ^ (t >> 14)) as f64;
        val / 4294967296.0
    }
}

fn compare_key(a: &EntityKey, b: &EntityKey) -> std::cmp::Ordering {
    a.to_string_repr().cmp(&b.to_string_repr())
}

fn uncertainty_of(hint: &TrustHint) -> f64 {
    default_wilson_width(hint.successes, hint.trials).unwrap_or(1.0)
}

/// Evidential Knapsack Context Packer (§6.3)
pub fn pack_entities(
    candidates: &[PackCandidate],
    policy: &PackPolicy,
) -> Result<PackOutcome, CoreError> {
    if policy.exploration_ratio < 0.0 || policy.exploration_ratio > 1.0 {
        return Err(CoreError::InvalidArgument {
            name: "exploration_ratio",
            reason: format!("must be in [0, 1], found {}", policy.exploration_ratio),
        });
    }

    for c in candidates {
        if c.cost == 0 {
            return Err(CoreError::InvalidArgument {
                name: "candidate.cost",
                reason: "cost must be a positive integer".to_string(),
            });
        }
    }

    if policy.budget == 0 || candidates.is_empty() {
        return Ok(PackOutcome {
            selected: Vec::new(),
            rejected: candidates.to_vec(),
            budget: policy.budget,
            total_cost: 0,
            remaining_budget: policy.budget,
            utilization: 0.0,
            mandatory_count: 0,
            probation_count: 0,
            merit_count: 0,
        });
    }

    let mut eligible = Vec::new();
    let mut rejected = Vec::new();

    for c in candidates {
        let status = c.hint.status;
        if status == LifecycleStatus::Quarantined && !policy.allow_quarantined {
            rejected.push(c.clone());
            continue;
        }
        if status == LifecycleStatus::Retired && !policy.allow_retired {
            rejected.push(c.clone());
            continue;
        }
        if !c.mandatory && c.hint.trust < policy.min_trust {
            rejected.push(c.clone());
            continue;
        }
        eligible.push(c.clone());
    }

    let mut selected = Vec::new();
    let mut remaining_budget = policy.budget;

    // Stage 1: Mandatory candidates
    let mut mandatory_candidates = Vec::new();
    let mut standard_candidates = Vec::new();

    for c in eligible {
        if c.mandatory {
            mandatory_candidates.push(c);
        } else {
            standard_candidates.push(c);
        }
    }

    mandatory_candidates.sort_by(|a, b| {
        b.hint
            .trust
            .partial_cmp(&a.hint.trust)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| compare_key(&a.key, &b.key))
    });

    let mut mandatory_count = 0;
    for c in mandatory_candidates {
        if c.cost <= remaining_budget {
            remaining_budget -= c.cost;
            mandatory_count += 1;
            let density = round6(c.hint.trust / c.cost as f64).unwrap_or(0.0);
            let uncertainty = uncertainty_of(&c.hint);
            selected.push(PackedEntity {
                key: c.key,
                hint: c.hint,
                cost: c.cost,
                admitted_by: "mandatory".to_string(),
                density,
                uncertainty,
                payload: c.payload,
            });
        } else {
            rejected.push(c);
        }
    }

    // Stage 2: Exploration / Probation
    let mut probation_count = 0;
    let probation_candidates: Vec<PackCandidate> = standard_candidates
        .iter()
        .filter(|c| c.hint.status == LifecycleStatus::Probation)
        .cloned()
        .collect();

    let mut exploration_budget =
        (remaining_budget as f64 * policy.exploration_ratio).floor() as usize;
    let mut remaining_standard_pool = standard_candidates;

    if let Some(seed) = policy.seed {
        if !probation_candidates.is_empty() && exploration_budget > 0 {
            let mut rng = Mulberry32::new(seed);
            let mut pool = probation_candidates;
            let mut sampled = Vec::new();

            while !pool.is_empty() {
                let total_weight: f64 = pool.iter().map(|c| uncertainty_of(&c.hint)).sum();
                if total_weight <= 0.0 {
                    sampled.extend(pool);
                    break;
                }
                let mut draw = rng.next_f64() * total_weight;
                let mut chosen_idx = 0;
                for (idx, c) in pool.iter().enumerate() {
                    draw -= uncertainty_of(&c.hint);
                    if draw <= 0.0 {
                        chosen_idx = idx;
                        break;
                    }
                }
                sampled.push(pool.remove(chosen_idx));
            }

            for c in sampled {
                if c.cost <= exploration_budget && c.cost <= remaining_budget {
                    exploration_budget -= c.cost;
                    remaining_budget -= c.cost;
                    probation_count += 1;
                    if let Some(pos) = remaining_standard_pool.iter().position(|x| x.key == c.key) {
                        remaining_standard_pool.remove(pos);
                    }
                    let density = round6(c.hint.trust / c.cost as f64).unwrap_or(0.0);
                    let uncertainty = uncertainty_of(&c.hint);
                    selected.push(PackedEntity {
                        key: c.key,
                        hint: c.hint,
                        cost: c.cost,
                        admitted_by: "probation".to_string(),
                        density,
                        uncertainty,
                        payload: c.payload,
                    });
                }
            }
        }
    }

    // Stage 3: Merit Packing (greedy knapsack by evidential density desc)
    remaining_standard_pool.sort_by(|a, b| {
        let density_a = a.hint.trust / a.cost as f64;
        let density_b = b.hint.trust / b.cost as f64;
        density_b
            .partial_cmp(&density_a)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                b.hint
                    .trust
                    .partial_cmp(&a.hint.trust)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| compare_key(&a.key, &b.key))
    });

    let mut merit_count = 0;
    for c in remaining_standard_pool {
        if c.cost <= remaining_budget {
            remaining_budget -= c.cost;
            merit_count += 1;
            let density = round6(c.hint.trust / c.cost as f64).unwrap_or(0.0);
            let uncertainty = uncertainty_of(&c.hint);
            selected.push(PackedEntity {
                key: c.key,
                hint: c.hint,
                cost: c.cost,
                admitted_by: "merit".to_string(),
                density,
                uncertainty,
                payload: c.payload,
            });
        } else {
            rejected.push(c);
        }
    }

    let total_cost = policy.budget - remaining_budget;
    let utilization = if policy.budget > 0 {
        round6(total_cost as f64 / policy.budget as f64).unwrap_or(0.0)
    } else {
        0.0
    };

    Ok(PackOutcome {
        selected,
        rejected,
        budget: policy.budget,
        total_cost,
        remaining_budget,
        utilization,
        mandatory_count,
        probation_count,
        merit_count,
    })
}
