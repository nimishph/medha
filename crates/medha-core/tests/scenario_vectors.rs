use medha_core::{
    canonical_signals, compute_trust_and_status, fold_guard_step, fold_signal_step, EntityFoldState,
    KindSpec, LifecycleStatus, SignalLimits, TrustComputationInput,
};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

fn load_scenarios_json() -> Value {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.pop(); // crates
    path.pop(); // repo root
    path.push("docs");
    path.push("spec");
    path.push("vectors");
    path.push("scenarios.json");

    let content = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("Failed to read {}: {}", path.display(), e));
    serde_json::from_str(&content).expect("Valid JSON in scenarios.json")
}

#[test]
fn test_all_scenarios_conformance() {
    let json = load_scenarios_json();
    let scenarios = json["scenarios"].as_array().expect("scenarios array");
    let signals = canonical_signals();

    for scenario in scenarios {
        let name = scenario["name"].as_str().expect("scenario name");
        let now = scenario["now"].as_i64().expect("scenario now");

        let mut kind_spec = KindSpec::default();
        if let Some(ks) = scenario.get("kindSpec") {
            if let Some(thr) = ks.get("thresholds") {
                if let Some(tr) = thr["trusted"].as_f64() {
                    kind_spec.thresholds.trusted = tr;
                }
                if let Some(mn) = thr["minUsesForTrusted"].as_u64() {
                    kind_spec.thresholds.min_uses_for_trusted = mn;
                }
                if let Some(ac) = thr["active"].as_f64() {
                    kind_spec.thresholds.active = ac;
                }
                if let Some(uc) = thr["unguardedCeiling"].as_f64() {
                    kind_spec.thresholds.unguarded_ceiling = uc;
                }
            }
            if let Some(rec) = ks.get("recency") {
                if let Some(hl) = rec["halfLifeDays"].as_f64() {
                    kind_spec.recency.half_life_days = hl;
                }
                if let Some(fl) = rec["floor"].as_f64() {
                    kind_spec.recency.floor = fl;
                }
            }
            if let Some(ew) = ks.get("evidenceWeighting").and_then(|v| v.as_str()) {
                kind_spec.evidence_weighting = Some(ew.to_string());
            }
            if let Some(lim) = ks.get("signalLimits") {
                kind_spec.signal_limits = Some(SignalLimits {
                    min_interval_ms: lim["minIntervalMs"].as_i64(),
                    max_successes_per_author: lim["maxSuccessesPerAuthor"].as_u64(),
                });
            }
        }

        let mut state = EntityFoldState::default();
        if let Some(th0) = scenario.get("theta0").and_then(|v| v.as_f64()) {
            state.ema.theta0 = th0;
            state.ema.mu = th0;
        }
        if let Some(gk) = scenario.get("guardKind").and_then(|v| v.as_str()) {
            state.guard.kind = gk.to_string();
        }

        let steps = scenario["steps"].as_array().expect("steps array");
        for step in steps {
            if let Some(sig) = step.get("signal").and_then(|v| v.as_str()) {
                let at = step["at"].as_i64().expect("step at");
                let author = step.get("author").and_then(|v| v.as_str());
                let anchors = step.get("anchors").and_then(|v| v.as_array()).map(|arr| {
                    arr.iter()
                        .map(|pair| {
                            pair.as_array()
                                .expect("anchor pair")
                                .iter()
                                .map(|s| s.as_str().expect("str").to_string())
                                .collect()
                        })
                        .collect::<Vec<Vec<String>>>()
                });

                state = fold_signal_step(
                    state,
                    sig,
                    at,
                    author,
                    anchors.as_deref(),
                    &signals,
                    &kind_spec,
                )
                .unwrap_or_else(|e| panic!("Scenario '{}' signal failed: {:?}", name, e));
            } else if let Some(ok) = step.get("ok").and_then(|v| v.as_bool()) {
                let at = step["at"].as_i64().expect("guard step at");
                let kind = step.get("kind").and_then(|v| v.as_str());

                state = fold_guard_step(state, kind, ok, at, &kind_spec)
                    .unwrap_or_else(|e| panic!("Scenario '{}' guard failed: {:?}", name, e));
            }
        }

        // Final observation at `now`
        let result = compute_trust_and_status(TrustComputationInput {
            evidence: &state.evidence,
            guard: &state.guard,
            distinct_anchor_count: state.anchors.len(),
            ema: &state.ema,
            last_signal_at: state.last_signal_at,
            now,
            stored_status: state.status,
            status_override: state.status_override,
            thresholds: &kind_spec.thresholds,
            recency_config: &kind_spec.recency,
        })
        .unwrap_or_else(|e| panic!("Scenario '{}' final observation failed: {:?}", name, e));

        let exp = &scenario["expected"];
        let exp_trust = exp["trust"].as_f64().expect("exp trust");
        assert_eq!(
            result.trust, exp_trust,
            "Scenario '{}' trust mismatch: expected={}, actual={}",
            name, exp_trust, result.trust
        );

        let exp_status = exp["status"].as_str().expect("exp status");
        let actual_status_str = match result.status {
            LifecycleStatus::Probation => "probation",
            LifecycleStatus::Active => "active",
            LifecycleStatus::Trusted => "trusted",
            LifecycleStatus::Quarantined => "quarantined",
            LifecycleStatus::Retired => "retired",
        };
        assert_eq!(
            actual_status_str, exp_status,
            "Scenario '{}' status mismatch: expected={}, actual={}",
            name, exp_status, actual_status_str
        );
    }
}
