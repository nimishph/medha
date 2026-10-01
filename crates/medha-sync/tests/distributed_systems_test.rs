use medha_core::types::{EntityKey, SignalSpec};
use medha_store::{EpisodeInput, EpisodePayload, MemoryStore, StorePort};
use medha_sync::{merge_episodes, FileSyncAdapter, SyncPort};
use tempfile::tempdir;

fn sample_signal(id: &str, at: i64, value: f64, success: bool) -> EpisodeInput {
    EpisodeInput {
        key: EntityKey::new("", "rule", id),
        at,
        author: None,
        payload: EpisodePayload::Signal {
            spec: SignalSpec {
                name: if success { "APPLY".to_string() } else { "REJECT_RULE".to_string() },
                value,
                counts_as_trial: true,
                counts_as_success: success,
                description: Some("Signal".to_string()),
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

/// Distributed Test 1: 5-Node Gossip Mesh
///
/// Five independent replicas (R1, R2, R3, R4, R5) concurrently record overlapping signals
/// on shared entities. They synchronize via random pairwise gossiping.
/// INVARIANT: Regardless of gossip schedule, every replica must converge on:
///   1. Exactly identical episode log count and total sequence ordering
///   2. Exactly identical entity state projection and Wilson trust scores
#[test]
fn test_distributed_5_node_gossip_mesh_convergence() {
    let mut replicas: Vec<MemoryStore> = (0..5)
        .map(|_| {
            let mut s = MemoryStore::new(None);
            s.open().expect("open ok");
            s
        })
        .collect();

    // Node 0 logs signals for rule-A and rule-B
    replicas[0].append(sample_signal("rule-A", 1000, 1.0, true)).unwrap();
    replicas[0].append(sample_signal("rule-B", 1050, 1.0, true)).unwrap();

    // Node 1 logs signals for rule-B and rule-C
    replicas[1].append(sample_signal("rule-B", 1100, -1.0, false)).unwrap();
    replicas[1].append(sample_signal("rule-C", 1150, 1.0, true)).unwrap();

    // Node 2 logs signals for rule-A, rule-C, rule-D
    replicas[2].append(sample_signal("rule-A", 1200, 1.0, true)).unwrap();
    replicas[2].append(sample_signal("rule-C", 1250, 1.0, true)).unwrap();
    replicas[2].append(sample_signal("rule-D", 1300, -1.0, false)).unwrap();

    // Node 3 logs signals for rule-D and rule-E
    replicas[3].append(sample_signal("rule-D", 1350, 1.0, true)).unwrap();
    replicas[3].append(sample_signal("rule-E", 1400, 1.0, true)).unwrap();

    // Node 4 logs signals for rule-A and rule-E
    replicas[4].append(sample_signal("rule-A", 1450, -1.0, false)).unwrap();
    replicas[4].append(sample_signal("rule-E", 1500, 1.0, true)).unwrap();

    // Chaotic Pairwise Gossip Schedule
    let gossip_pairs = [
        (0, 1),
        (2, 3),
        (1, 4),
        (0, 3),
        (2, 4),
        (3, 1),
        (4, 0),
        (1, 2),
        (0, 2),
        (3, 4),
    ];

    for &(i, j) in &gossip_pairs {
        let log_i = replicas[i].episodes(None, None).unwrap();
        let log_j = replicas[j].episodes(None, None).unwrap();

        let merged = merge_episodes(&log_i, &log_j);

        replicas[i].replace_log(&merged).unwrap();
        replicas[i].rebuild().unwrap();

        replicas[j].replace_log(&merged).unwrap();
        replicas[j].rebuild().unwrap();
    }

    // Verify all 5 replicas converged identically
    let reference_log = replicas[0].episodes(None, None).unwrap();
    let reference_states = replicas[0].list().unwrap();

    assert_eq!(reference_log.len(), 11, "All 11 unique episodes must be present");
    assert_eq!(reference_states.len(), 5, "All 5 unique entities (A, B, C, D, E) must be present");

    for idx in 1..5 {
        let ep = replicas[idx].episodes(None, None).unwrap();
        let st = replicas[idx].list().unwrap();

        assert_eq!(ep, reference_log, "Replica {} log must match reference replica 0 byte-for-byte", idx);
        assert_eq!(st, reference_states, "Replica {} states must match reference replica 0 byte-for-byte", idx);
    }
}

/// Distributed Test 2: Cross-Replica Retraction Race
///
/// Replica 1 logs an episode.
/// Replica 2 syncs it, numbers it seq=0, and logs a RETRACTION for it.
/// Meanwhile, Replica 3 logs other signals and numbers the original episode differently.
/// When all three reconcile, the retraction must successfully resolve to its target across
/// replicas without masking the wrong episode or creating dangling references.
#[test]
fn test_distributed_cross_replica_retraction_resolution() {
    let mut r1 = MemoryStore::new(None);
    r1.open().unwrap();
    let mut r2 = MemoryStore::new(None);
    r2.open().unwrap();
    let mut r3 = MemoryStore::new(None);
    r3.open().unwrap();

    // R1 creates rule-bad at t=100
    r1.append(sample_signal("rule-bad", 100, 1.0, true)).unwrap();

    // R2 pulls from R1
    let r1_log = r1.episodes(None, None).unwrap();
    r2.replace_log(&r1_log).unwrap();
    r2.rebuild().unwrap();

    // R2 issues a Retract against seq 0
    let retract_ep = EpisodeInput {
        key: EntityKey::new("", "rule", "rule-bad"),
        at: 300,
        author: None,
        payload: EpisodePayload::Retract {
            target_seq: 0,
            reason: "malicious signal detected by auditor".to_string(),
        },
    };
    r2.append(retract_ep).unwrap();

    // Concurrently, R3 logged other rules BEFORE seeing rule-bad, so rule-bad would get a different seq
    r3.append(sample_signal("rule-innocent-1", 50, 1.0, true)).unwrap();
    r3.append(sample_signal("rule-innocent-2", 75, 1.0, true)).unwrap();
    r3.append(sample_signal("rule-bad", 100, 1.0, true)).unwrap(); // Same episode as R1

    // Merge R2 and R3
    let log_r2 = r2.episodes(None, None).unwrap();
    let log_r3 = r3.episodes(None, None).unwrap();

    let merged_23 = merge_episodes(&log_r2, &log_r3);
    r2.replace_log(&merged_23).unwrap();
    r2.rebuild().unwrap();

    r3.replace_log(&merged_23).unwrap();
    r3.rebuild().unwrap();

    // Verify:
    // 1. rule-bad was retracted (trials n == 0)
    // 2. innocent rules were NOT retracted (trials n == 1 each)
    let states = r3.list().unwrap();
    let bad_state = states.iter().find(|s| s.key.id == "rule-bad").unwrap();
    assert_eq!(bad_state.evidence.n, 0.0, "Retracted episode must not contribute to trials");

    let inn1 = states.iter().find(|s| s.key.id == "rule-innocent-1").unwrap();
    assert_eq!(inn1.evidence.n, 1.0, "Innocent rule 1 must remain active");

    let inn2 = states.iter().find(|s| s.key.id == "rule-innocent-2").unwrap();
    assert_eq!(inn2.evidence.n, 1.0, "Innocent rule 2 must remain active");
}

/// Distributed Test 3: Network Partition & Split-Brain Healing
///
/// A cluster divides into Partition 1 (Nodes A, B) and Partition 2 (Nodes C, D).
/// During the partition, both partitions continue active writes on overlapping entities.
/// The partition heals. All nodes reconcile in arbitrary sequence.
/// Mathematical property verified: Commutativity & Associativity under network partition.
#[test]
fn test_distributed_network_partition_and_split_brain_healing() {
    let mut node_a = MemoryStore::new(None);
    node_a.open().unwrap();
    let mut node_b = MemoryStore::new(None);
    node_b.open().unwrap();
    let mut node_c = MemoryStore::new(None);
    node_c.open().unwrap();
    let mut node_d = MemoryStore::new(None);
    node_d.open().unwrap();

    // Common baseline before partition
    let init_signal = sample_signal("shared-rule", 100, 1.0, true);
    for n in [&mut node_a, &mut node_b, &mut node_c, &mut node_d] {
        n.append(init_signal.clone()).unwrap();
    }

    // --- PARTITION BEGINS ---
    // Partition 1 (A & B) processes 500 signals
    for i in 0..500 {
        let ts = 200 + i;
        if i % 2 == 0 {
            node_a.append(sample_signal("shared-rule", ts, 1.0, true)).unwrap();
        } else {
            node_b.append(sample_signal("shared-rule", ts, 1.0, true)).unwrap();
        }
    }
    // Sync within Partition 1
    let merged_ab = merge_episodes(&node_a.episodes(None, None).unwrap(), &node_b.episodes(None, None).unwrap());
    node_a.replace_log(&merged_ab).unwrap();
    node_b.replace_log(&merged_ab).unwrap();

    // Partition 2 (C & D) concurrently processes 500 signals with some failures
    for i in 0..500 {
        let ts = 800 + i;
        let success = i % 5 != 0;
        let val = if success { 1.0 } else { -1.0 };
        if i % 2 == 0 {
            node_c.append(sample_signal("shared-rule", ts, val, success)).unwrap();
        } else {
            node_d.append(sample_signal("shared-rule", ts, val, success)).unwrap();
        }
    }
    // Sync within Partition 2
    let merged_cd = merge_episodes(&node_c.episodes(None, None).unwrap(), &node_d.episodes(None, None).unwrap());
    node_c.replace_log(&merged_cd).unwrap();
    node_d.replace_log(&merged_cd).unwrap();

    // --- PARTITION HEALS ---
    // Cross-partition bridge: Node B syncs with Node C
    let cross_bc = merge_episodes(&node_b.episodes(None, None).unwrap(), &node_c.episodes(None, None).unwrap());
    node_b.replace_log(&cross_bc).unwrap();
    node_c.replace_log(&cross_bc).unwrap();

    // Gossip propagates to A and D
    let full_a = merge_episodes(&node_a.episodes(None, None).unwrap(), &node_b.episodes(None, None).unwrap());
    node_a.replace_log(&full_a).unwrap();
    node_a.rebuild().unwrap();

    let full_d = merge_episodes(&node_d.episodes(None, None).unwrap(), &node_c.episodes(None, None).unwrap());
    node_d.replace_log(&full_d).unwrap();
    node_d.rebuild().unwrap();

    // Verify 100% convergence across all partitions
    let state_a = node_a.list().unwrap();
    let state_d = node_d.list().unwrap();

    assert_eq!(state_a[0].evidence.n, 1001.0, "Total trials must equal 1 initial + 500 from P1 + 500 from P2");
    assert_eq!(state_a, state_d, "Partition 1 and Partition 2 must achieve identical belief state");
}

/// Distributed Test 4: CAS Divergence & Safe Concurrent Push via File Adapter
#[test]
fn test_distributed_cas_contention_and_recovery() {
    let dir = tempdir().unwrap();
    let sync_file = dir.path().join("cluster-memory.json");

    let mut replica_1 = MemoryStore::new(None);
    replica_1.open().unwrap();
    let mut replica_2 = MemoryStore::new(None);
    replica_2.open().unwrap();

    let mut adapter_1 = FileSyncAdapter::new(replica_1, &sync_file);
    let mut adapter_2 = FileSyncAdapter::new(replica_2, &sync_file);

    // Initial push from Replica 1
    adapter_1.store_mut().append(sample_signal("rule-1", 100, 1.0, true)).unwrap();
    let push_1 = adapter_1.push(Some(100)).unwrap();
    assert!(push_1.ok);

    // Replica 2 pulls the initial state
    let pull_2 = adapter_2.pull().unwrap();
    assert!(pull_2.ok);

    // Concurrent race: Both replicas append new local signals
    adapter_1.store_mut().append(sample_signal("rule-2", 200, 1.0, true)).unwrap();
    adapter_2.store_mut().append(sample_signal("rule-3", 300, 1.0, true)).unwrap();

    // Replica 1 pushes first -> SUCCEEDS
    let push_race_1 = adapter_1.push(Some(200)).unwrap();
    assert!(push_race_1.ok);

    // Replica 2 attempts to push stale snapshot -> REFUSED with CAS divergence error
    let push_race_2 = adapter_2.push(Some(300)).unwrap();
    assert!(!push_race_2.ok, "Concurrent push without pulling must be refused");
    assert!(push_race_2.error.unwrap().contains("changed since last pull"));

    // Replica 2 recovers via reconcile() (pulls latest, merges CRDT, pushes merged result)
    let rec_2 = adapter_2.reconcile(Some(400)).unwrap();
    assert!(rec_2.ok);

    // Replica 1 pulls merged result
    let pull_1 = adapter_1.pull().unwrap();
    assert!(pull_1.ok);

    // Both replicas now hold all 3 rules
    let list_1 = adapter_1.store().list().unwrap();
    let list_2 = adapter_2.store().list().unwrap();

    assert_eq!(list_1.len(), 3);
    assert_eq!(list_2.len(), 3);
    assert_eq!(list_1, list_2);
}
