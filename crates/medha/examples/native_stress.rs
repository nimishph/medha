use medha_core::formula::{compute_trust_and_status, TrustComputationInput};
use medha_core::types::{
    EmaState, Evidence, GuardState, LifecycleStatus, RecencyConfig, Thresholds,
};
use medha_core::wilson::wilson_lower_bound;
use medha_store::{EpisodeInput, EpisodePayload, MemoryStore, StorePort};
use medha_core::types::{EntityKey, SignalSpec};
use std::time::Instant;

fn make_signal(id: &str, at: i64, success: bool) -> EpisodeInput {
    EpisodeInput {
        key: EntityKey::new("", "rule", id),
        at,
        author: None,
        payload: EpisodePayload::Signal {
            spec: SignalSpec {
                name: if success {
                    "APPLY".to_string()
                } else {
                    "REJECT_RULE".to_string()
                },
                value: if success { 1.0 } else { -1.0 },
                counts_as_trial: true,
                counts_as_success: success,
                description: Some("Stress Signal".to_string()),
            },
            anchors: None,
            ensure: true,
            run_ref: None,
            note: None,
            updater: None,
            weight: None,
            case_id: None,
        },
    }
}

fn main() {
    // 1. Wilson Lower Bound (1,000,000 iterations)
    let wilson_iterations = 1_000_000;
    let t0 = Instant::now();
    let mut wilson_sum = 0.0;
    for i in 1..=wilson_iterations {
        let k = (i % 100) as f64;
        let n = 100.0;
        let bound = wilson_lower_bound(k, n, 1.959964).unwrap_or(0.0);
        wilson_sum += bound;
    }
    let wilson_duration_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // 2. Full Bayesian Trust & Status Computation (250,000 iterations)
    let trust_iterations = 250_000;
    let thresholds = Thresholds::default();
    let recency_config = RecencyConfig::default();
    let t1 = Instant::now();
    let mut trust_sum = 0.0;

    for i in 0..trust_iterations {
        let successes = (i % 50) as f64;
        let trials = 50.0;
        let evidence = Evidence {
            k: successes,
            n: trials,
            context_rejects: 0,
        };
        let guard = GuardState {
            kind: "linter".to_string(),
            last_ok: Some(i % 2 == 0),
            last_ok_at: Some(1000 + i as i64),
        };
        let ema = EmaState {
            mu: successes / trials,
            theta0: 0.8,
            sample_count: 50,
        };

        let res = compute_trust_and_status(TrustComputationInput {
            evidence: &evidence,
            guard: &guard,
            distinct_anchor_count: 3,
            ema: &ema,
            last_signal_at: Some(1000 + i as i64),
            now: 2000 + i as i64,
            stored_status: LifecycleStatus::Active,
            status_override: None,
            thresholds: &thresholds,
            recency_config: &recency_config,
        })
        .unwrap();

        trust_sum += res.trust;
    }
    let trust_duration_ms = t1.elapsed().as_secs_f64() * 1000.0;

    // 3. In-Memory Store Episode Ingestion & Folding (50,000 episodes)
    let store_episodes = 50_000;
    let mut store = MemoryStore::new(None);
    store.open().expect("open store");

    let t2 = Instant::now();
    for i in 0..store_episodes {
        let id = format!("rule-stress-{:05}", i % 5000);
        let success = i % 3 != 0;
        store
            .append(make_signal(&id, 1000 + i as i64, success))
            .unwrap();
    }
    let store_duration_ms = t2.elapsed().as_secs_f64() * 1000.0;

    let output = serde_json::json!({
        "wilson": {
            "iterations": wilson_iterations,
            "durationMs": wilson_duration_ms,
            "throughput": (wilson_iterations as f64) / (wilson_duration_ms / 1000.0),
            "checksum": wilson_sum
        },
        "trustAndStatus": {
            "iterations": trust_iterations,
            "durationMs": trust_duration_ms,
            "throughput": (trust_iterations as f64) / (trust_duration_ms / 1000.0),
            "checksum": trust_sum
        },
        "memoryStore": {
            "episodes": store_episodes,
            "durationMs": store_duration_ms,
            "throughput": (store_episodes as f64) / (store_duration_ms / 1000.0)
        }
    });

    println!("{}", output.to_string());
}
