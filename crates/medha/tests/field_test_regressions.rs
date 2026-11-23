//! Regressions from the 0.8.0-alpha.1 field test: compaction age cutoff and policy trust.

use medha::core::policy_latch::PolicyLatchInput;
use medha::core::types::EntityKey;
use medha::store::{EpisodePayload, MemoryStore, StorePort};
use medha::{GuardInput, MedhaEngine, RecordInput};

const DAY: i64 = 86_400_000;

fn apply(engine: &mut MedhaEngine<MemoryStore>, key: &EntityKey, signal: &str, at: i64) -> u64 {
    engine
        .record(RecordInput {
            key: key.clone(),
            signal: signal.to_string(),
            at,
            ensure: true,
            author: None,
            anchors: None,
            run_ref: None,
            note: None,
            case_id: None,
        })
        .expect("record")
        .episode
        .seq
}

#[test]
fn compact_older_than_keeps_recent_history() {
    let mut engine = MedhaEngine::open_in_memory().expect("open");
    let key = EntityKey::new("", "rule", "r");
    let now = 200 * DAY;
    // Three old episodes (well past 90 days) and three recent ones.
    for i in 0..3 {
        apply(&mut engine, &key, "APPLY", 10 * DAY + i);
    }
    for i in 0..3 {
        apply(&mut engine, &key, "APPLY", now - DAY + i);
    }
    let before = engine.hint(&key, now).expect("hint");

    let report = engine.compact_older_than(now, None).expect("compact");
    assert_eq!(report.before_count, 6);
    assert_eq!(report.after_count, 4, "1 baseline + 3 recent episodes kept");

    let after = engine.hint(&key, now).expect("hint");
    assert_eq!(before.trust, after.trust, "compaction is fold-equivalent");

    // Nothing is old enough with a cutoff far in the past: a no-op.
    let noop = engine
        .compact_older_than(now, Some(1000.0))
        .expect("compact");
    assert_eq!(noop.removed_count, 0);
    assert_eq!(noop.after_count, 4);
}

#[test]
fn compact_older_than_with_fresh_log_is_noop() {
    let mut engine = MedhaEngine::open_in_memory().expect("open");
    let key = EntityKey::new("", "rule", "fresh");
    let now = 100 * DAY;
    for i in 0..5 {
        apply(&mut engine, &key, "APPLY", now - 60_000 + i);
    }
    let report = engine.compact_older_than(now, None).expect("compact");
    assert_eq!(report.removed_count, 0);
    assert_eq!(report.after_count, 5);
}

#[test]
fn compact_resolves_suffix_retractions() {
    let mut engine = MedhaEngine::open_in_memory().expect("open");
    let key = EntityKey::new("", "rule", "r");
    let now = 200 * DAY;
    let old_bad = apply(&mut engine, &key, "REJECT_RULE", 10 * DAY);
    apply(&mut engine, &key, "APPLY", 11 * DAY);
    let recent = apply(&mut engine, &key, "APPLY", now - DAY);
    let recent_bad = apply(&mut engine, &key, "REJECT_RULE", now - DAY + 1);
    // Retract one old (to-be-folded) episode and one recent (kept) episode.
    engine
        .retract(old_bad, "wrong", now - 100)
        .expect("retract old");
    engine
        .retract(recent_bad, "wrong", now - 50)
        .expect("retract recent");
    let before = engine.get(&key).expect("get").expect("known");

    engine.compact_older_than(now, None).expect("compact");

    let after = engine.get(&key).expect("get").expect("known");
    assert_eq!(before.evidence.k, after.evidence.k);
    assert_eq!(before.evidence.n, after.evidence.n);

    // The kept retraction was renumbered onto its (renumbered) target.
    let eps = engine.store().episodes(None, None).expect("episodes");
    let seqs: Vec<u64> = eps.iter().map(|e| e.seq).collect();
    assert_eq!(
        seqs,
        (0..eps.len() as u64).collect::<Vec<_>>(),
        "contiguous"
    );
    let retracts: Vec<u64> = eps
        .iter()
        .filter_map(|e| match &e.payload {
            EpisodePayload::Retract { target_seq, .. } => Some(*target_seq),
            _ => None,
        })
        .collect();
    assert_eq!(
        retracts.len(),
        1,
        "the retraction of a folded episode is spent"
    );
    let target = &eps[retracts[0] as usize];
    assert!(
        matches!(&target.payload, EpisodePayload::Signal { spec, .. } if spec.name == "REJECT_RULE")
    );
    let _ = recent;
}

#[test]
fn full_compact_still_folds_everything() {
    let mut engine = MedhaEngine::open_in_memory().expect("open");
    let key = EntityKey::new("", "rule", "r");
    for i in 0..4 {
        apply(&mut engine, &key, "APPLY", 1000 + i);
    }
    let report = engine.compact(2000).expect("compact");
    assert_eq!(report.after_count, 1);
}

#[test]
fn policy_reports_calibrated_trust_not_success_ratio() {
    let mut engine = MedhaEngine::open_in_memory().expect("open");
    let key = EntityKey::new("", "rule", "r");
    let now = 10 * DAY;
    for i in 0..3 {
        apply(&mut engine, &key, "APPLY", now - 10 + i);
    }
    engine
        .guard(GuardInput {
            key: key.clone(),
            ok: true,
            kind: Some("tests".to_string()),
            at: now - 1,
            author: None,
            note: None,
        })
        .expect("guard");
    let hint = engine.hint(&key, now).expect("hint");
    assert!(hint.trust < 0.9, "3/3 successes is not near-certain trust");

    let outcome = engine
        .policy_latch(
            &PolicyLatchInput {
                key: key.clone(),
                context: None,
                author: None,
                action: Some("apply".to_string()),
                min_trust: Some(0.9),
            },
            now,
        )
        .expect("policy");
    assert!(
        (outcome.trust - hint.trust).abs() < 1e-9,
        "policy trust matches show"
    );
    assert!(!outcome.allowed, "minTrust gates on calibrated trust");
}
