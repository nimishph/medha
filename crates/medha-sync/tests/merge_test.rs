use medha_core::types::{Anchor, EntityKey, LifecycleStatus, SignalSpec};
use medha_store::{EntityState, Episode, EpisodePayload};
use medha_sync::{canonical_episode_key, merge_entity_states, merge_episodes};

fn canonical_apply() -> SignalSpec {
    SignalSpec {
        name: "APPLY".to_string(),
        value: 1.0,
        counts_as_trial: true,
        counts_as_success: true,
        description: Some("Applied".to_string()),
    }
}

fn create_signal_episode(
    seq: u64,
    id: &str,
    at: i64,
    spec: SignalSpec,
    updater: Option<&str>,
    weight: Option<f64>,
) -> Episode {
    Episode {
        seq,
        key: EntityKey::new("", "rule", id),
        at,
        author: None,
        payload: EpisodePayload::Signal {
            spec,
            anchors: None,
            ensure: true,
            run_ref: None,
            note: None,
            updater: updater.map(|s| s.to_string()),
            weight,
            case_id: None,
        },
    }
}

fn create_retract_episode(seq: u64, target_seq: u64, at: i64, id: &str, reason: &str) -> Episode {
    Episode {
        seq,
        key: EntityKey::new("", "rule", id),
        at,
        author: None,
        payload: EpisodePayload::Retract {
            target_seq,
            reason: reason.to_string(),
        },
    }
}

#[test]
fn test_merge_episodes_commutativity() {
    let log_a = vec![
        create_signal_episode(1, "rule-1", 1000, canonical_apply(), None, None),
        create_signal_episode(2, "rule-2", 3000, canonical_apply(), None, None),
    ];
    let log_b = vec![
        create_signal_episode(1, "rule-1", 1000, canonical_apply(), None, None),
        create_signal_episode(2, "rule-3", 2000, canonical_apply(), None, None),
    ];

    let merged_ab = merge_episodes(&log_a, &log_b);
    let merged_ba = merge_episodes(&log_b, &log_a);

    assert_eq!(merged_ab, merged_ba);
    assert_eq!(merged_ab.len(), 3);

    // Chronological order: 1000, 2000, 3000
    assert_eq!(merged_ab[0].key.id, "rule-1");
    assert_eq!(merged_ab[1].key.id, "rule-3");
    assert_eq!(merged_ab[2].key.id, "rule-2");

    let seqs: Vec<u64> = merged_ab.iter().map(|e| e.seq).collect();
    assert_eq!(seqs, vec![0, 1, 2]);
}

#[test]
fn test_merge_episodes_associativity() {
    let log_a = vec![create_signal_episode(1, "r1", 100, canonical_apply(), None, None)];
    let log_b = vec![create_signal_episode(1, "r2", 200, canonical_apply(), None, None)];
    let log_c = vec![create_signal_episode(1, "r3", 300, canonical_apply(), None, None)];

    let left = merge_episodes(&merge_episodes(&log_a, &log_b), &log_c);
    let right = merge_episodes(&log_a, &merge_episodes(&log_b, &log_c));

    assert_eq!(left, right);
}

#[test]
fn test_merge_episodes_idempotency() {
    let log = vec![
        create_signal_episode(0, "r1", 100, canonical_apply(), None, None),
        create_signal_episode(1, "r2", 200, canonical_apply(), None, None),
    ];

    let merged = merge_episodes(&log, &log);
    assert_eq!(merged, log);
}

#[test]
fn test_retractions_have_distinct_canonical_keys() {
    let of_first = canonical_episode_key(&create_retract_episode(0, 0, 300, "r1", "bad signal"));
    let of_second = canonical_episode_key(&create_retract_episode(0, 1, 300, "r1", "bad signal"));
    assert_ne!(of_first, of_second);
}

#[test]
fn test_repoints_surviving_retraction_after_renumbering() {
    let local = vec![
        create_signal_episode(0, "r1", 100, canonical_apply(), None, None),
        create_signal_episode(1, "r1", 200, canonical_apply(), None, None),
        create_retract_episode(2, 0, 300, "r1", "bad signal"),
    ];
    let incoming = vec![
        create_signal_episode(0, "r1", 50, canonical_apply(), None, None),
        create_signal_episode(1, "r1", 150, canonical_apply(), None, None),
        create_signal_episode(2, "r1", 250, canonical_apply(), None, None),
    ];

    let merged = merge_episodes(&local, &incoming);
    let retraction = merged
        .iter()
        .find(|e| matches!(e.payload, EpisodePayload::Retract { .. }))
        .expect("retraction exists");

    if let EpisodePayload::Retract { target_seq, .. } = retraction.payload {
        let target = merged
            .iter()
            .find(|e| e.seq == target_seq)
            .expect("target exists");
        // Target was at 100
        assert_eq!(target.at, 100);
    } else {
        panic!("expected retract payload");
    }
}

#[test]
fn test_dedupes_same_retraction_under_different_numbering() {
    let replica_a = vec![
        create_signal_episode(0, "other", 10, canonical_apply(), None, None),
        create_signal_episode(1, "r1", 100, canonical_apply(), None, None),
        create_signal_episode(2, "r1", 200, canonical_apply(), None, None),
        create_retract_episode(3, 1, 300, "r1", "bad signal"),
    ];
    let replica_b = vec![
        create_signal_episode(0, "r1", 100, canonical_apply(), None, None),
        create_signal_episode(1, "r1", 200, canonical_apply(), None, None),
        create_retract_episode(2, 0, 300, "r1", "bad signal"),
    ];

    let merged = merge_episodes(&replica_a, &replica_b);
    let retractions: Vec<&Episode> = merged
        .iter()
        .filter(|e| matches!(e.payload, EpisodePayload::Retract { .. }))
        .collect();

    assert_eq!(retractions.len(), 1);
    if let EpisodePayload::Retract { target_seq, .. } = retractions[0].payload {
        let target = merged
            .iter()
            .find(|e| e.seq == target_seq)
            .expect("target exists");
        assert_eq!(target.at, 100);
    }
}

#[test]
fn test_merge_entity_states() {
    let s1 = EntityState {
        key: EntityKey::new("", "rule", "rule-1"),
        evidence: medha_core::types::Evidence {
            k: 8.0,
            n: 10.0,
            context_rejects: 0,
        },
        guard: medha_core::types::GuardState {
            kind: "ast".to_string(),
            last_ok: Some(true),
            last_ok_at: Some(1000),
        },
        anchors: vec![Anchor::new("git-head", "sha-1")],
        ema: medha_core::types::EmaState {
            mu: 0.8,
            theta0: 0.5,
            sample_count: 10,
        },
        status: LifecycleStatus::Active,
        status_override: None,
        last_signal_at: Some(1000),
        updater: "ema".to_string(),
        decision_tree: Vec::new(),
    };

    let s2 = EntityState {
        key: EntityKey::new("", "rule", "rule-1"),
        evidence: medha_core::types::Evidence {
            k: 2.0,
            n: 10.0,
            context_rejects: 1,
        },
        guard: medha_core::types::GuardState {
            kind: "ast".to_string(),
            last_ok: Some(true),
            last_ok_at: Some(2000),
        },
        anchors: vec![Anchor::new("git-head", "sha-2")],
        ema: medha_core::types::EmaState {
            mu: 0.4,
            theta0: 0.5,
            sample_count: 10,
        },
        status: LifecycleStatus::Probation,
        status_override: None,
        last_signal_at: Some(2000),
        updater: "ema".to_string(),
        decision_tree: Vec::new(),
    };

    let merged_12 = merge_entity_states(&[s1.clone()], &[s2.clone()]).expect("merge ok");
    let merged_21 = merge_entity_states(&[s2], &[s1]).expect("merge ok");

    assert_eq!(merged_12, merged_21);
    assert_eq!(merged_12.len(), 1);

    let m = &merged_12[0];
    assert_eq!(m.evidence.n, 20.0);
    assert_eq!(m.evidence.k, 10.0);
    assert_eq!(m.evidence.context_rejects, 1);
    // (10 * 0.8 + 10 * 0.4) / 20 = 0.6
    assert_eq!(m.ema.mu, 0.6);
    assert_eq!(m.last_signal_at, Some(2000));
    assert_eq!(m.anchors.len(), 2);
}
