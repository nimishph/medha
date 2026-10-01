use medha_core::{
    default_wilson_lower, ema_step, raw_durability_factor, recency_factor, round6, RecencyConfig,
};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

fn load_components_json() -> Value {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.pop(); // crates
    path.pop(); // repo root
    path.push("docs");
    path.push("spec");
    path.push("vectors");
    path.push("components.json");

    let content = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("Failed to read {}: {}", path.display(), e));
    serde_json::from_str(&content).expect("Valid JSON in components.json")
}

#[test]
fn test_conformance_round6() {
    let json = load_components_json();
    let cases = json["round6"].as_array().expect("round6 array");

    for (i, case) in cases.iter().enumerate() {
        let input = case["input"].as_f64().expect("input f64");
        let expected = case["expected"].as_f64().expect("expected f64");
        let actual = round6(input).expect("round6 success");
        assert_eq!(
            actual, expected,
            "round6 test case {} failed: input={}, expected={}, actual={}",
            i, input, expected, actual
        );
    }
}

#[test]
fn test_conformance_wilson_lower() {
    let json = load_components_json();
    let cases = json["wilsonLower"].as_array().expect("wilsonLower array");

    for (i, case) in cases.iter().enumerate() {
        let k = case["k"].as_f64().expect("k f64");
        let n = case["n"].as_f64().expect("n f64");
        let expected = case["expected"].as_f64().expect("expected f64");
        let actual = default_wilson_lower(k, n).expect("wilson lower success");
        assert_eq!(
            actual, expected,
            "wilsonLower test case {} failed: k={}, n={}, expected={}, actual={}",
            i, k, n, expected, actual
        );
    }
}

#[test]
fn test_conformance_recency() {
    let json = load_components_json();
    let cases = json["recency"].as_array().expect("recency array");

    for (i, case) in cases.iter().enumerate() {
        let last_used = case["lastUsedAt"].as_i64();
        let now = case["now"].as_i64().expect("now i64");
        let config_obj = &case["config"];
        let mut config = RecencyConfig::default();
        if let Some(hl) = config_obj["halfLifeDays"].as_f64() {
            config.half_life_days = hl;
        }
        if let Some(fl) = config_obj["floor"].as_f64() {
            config.floor = fl;
        }
        let expected = case["expected"].as_f64().expect("expected f64");
        let actual = recency_factor(last_used, now, &config).expect("recency success");
        assert_eq!(
            actual, expected,
            "recency test case {} failed: expected={}, actual={}",
            i, expected, actual
        );
    }
}

#[test]
fn test_conformance_durability() {
    let json = load_components_json();
    let cases = json["durability"].as_array().expect("durability array");

    for (i, case) in cases.iter().enumerate() {
        let h = case["h"].as_u64().expect("h u64") as usize;
        let expected = case["expected"].as_f64().expect("expected f64");
        let actual = raw_durability_factor(h).expect("durability success");
        assert_eq!(
            actual, expected,
            "durability test case {} failed: h={}, expected={}, actual={}",
            i, h, expected, actual
        );
    }
}

#[test]
fn test_conformance_ema_step() {
    let json = load_components_json();
    let cases = json["emaStep"].as_array().expect("emaStep array");

    for (i, case) in cases.iter().enumerate() {
        let mu = case["mu"].as_f64();
        let signal = case["signal"].as_f64().expect("signal f64");
        let alpha = case["alpha"].as_f64().expect("alpha f64");
        let expected = case["expected"].as_f64().expect("expected f64");
        let actual = ema_step(mu, signal, alpha).expect("ema_step success");
        assert_eq!(
            actual, expected,
            "emaStep test case {} failed: mu={:?}, signal={}, alpha={}, expected={}, actual={}",
            i, mu, signal, alpha, expected, actual
        );
    }
}
