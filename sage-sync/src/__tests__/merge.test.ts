/**
 * Unit tests for deterministic episode & state merge (§7.2, §14.4).
 *
 * Verifies mathematical properties: commutativity, associativity, idempotency,
 * and convergence of replicas with differing weight updater strategies.
 */

import { describe, expect, it } from 'bun:test';
import { type EntityState, type Episode, foldLog, type SignalEpisode } from '@sutras/sage-core';
import { mergeEntityStates, mergeEpisodes } from '../index.ts';

const CANONICAL_APPLY = {
  name: 'APPLY',
  value: 1.0,
  countsAsTrial: true,
  countsAsSuccess: true,
};

const CANONICAL_REJECT = {
  name: 'REJECT_RULE',
  value: -1.0,
  countsAsTrial: true,
  countsAsSuccess: false,
};

function createSignalEpisode(
  seq: number,
  id: string,
  at: number,
  spec = CANONICAL_APPLY,
  options: { updater?: string; weight?: number } = {},
): SignalEpisode {
  return {
    seq,
    key: { namespace: '', kind: 'rule', id },
    at,
    type: 'signal',
    spec,
    ensure: true,
    ...(options.updater !== undefined ? { updater: options.updater } : {}),
    ...(options.weight !== undefined ? { weight: options.weight } : {}),
  };
}

describe('mergeEpisodes — mathematical convergence', () => {
  it('is commutative: merge(A, B) === merge(B, A)', () => {
    const logA: Episode[] = [
      createSignalEpisode(1, 'rule-1', 1000),
      createSignalEpisode(2, 'rule-2', 3000),
    ];
    const logB: Episode[] = [
      createSignalEpisode(1, 'rule-1', 1000),
      createSignalEpisode(2, 'rule-3', 2000),
    ];

    const mergedAB = mergeEpisodes(logA, logB);
    const mergedBA = mergeEpisodes(logB, logA);

    expect(mergedAB).toEqual(mergedBA);
    expect(mergedAB).toHaveLength(3);
    // Chronological order: 1000, 2000, 3000
    expect(mergedAB[0]?.key.id).toBe('rule-1');
    expect(mergedAB[1]?.key.id).toBe('rule-3');
    expect(mergedAB[2]?.key.id).toBe('rule-2');
    expect(mergedAB.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('is associative: merge(merge(A, B), C) === merge(A, merge(B, C))', () => {
    const logA: Episode[] = [createSignalEpisode(1, 'r1', 100)];
    const logB: Episode[] = [createSignalEpisode(1, 'r2', 200)];
    const logC: Episode[] = [createSignalEpisode(1, 'r3', 300)];

    const left = mergeEpisodes(mergeEpisodes(logA, logB), logC);
    const right = mergeEpisodes(logA, mergeEpisodes(logB, logC));

    expect(left).toEqual(right);
  });

  it('is idempotent: merge(A, A) === A', () => {
    const log: Episode[] = [createSignalEpisode(0, 'r1', 100), createSignalEpisode(1, 'r2', 200)];

    const merged = mergeEpisodes(log, log);
    expect(merged).toEqual(log);
  });

  it('resolves Open Item 4: replicas with differing updater strategies converge when merged in either order', () => {
    // Replica A updated rule-1 with 'wilson' strategy
    const epReplicaA = createSignalEpisode(1, 'rule-1', 1000, CANONICAL_APPLY, {
      updater: 'wilson',
      weight: 0.35,
    });
    // Replica B updated rule-1 with 'sliding-window' strategy
    const epReplicaB = createSignalEpisode(1, 'rule-1', 2000, CANONICAL_REJECT, {
      updater: 'sliding-window',
      weight: 0.2,
    });

    const mergedAB = mergeEpisodes([epReplicaA], [epReplicaB]);
    const mergedBA = mergeEpisodes([epReplicaB], [epReplicaA]);

    expect(mergedAB).toEqual(mergedBA);

    // Fold equivalence: folding merged log in either order produces identical state
    const stateAB = foldLog(mergedAB)[0];
    const stateBA = foldLog(mergedBA)[0];

    expect(stateAB).toEqual(stateBA);
    expect(stateAB?.evidence.n).toBe(2);
    expect(stateAB?.evidence.k).toBe(1);
    expect(stateAB?.ema.mu).toBe(0.2); // Last applied weight from chronological sequence
  });
});

describe('mergeEntityStates — 2-way state merge', () => {
  it('is commutative and calculates sample-weighted EMA mu', () => {
    const s1: EntityState = {
      key: { namespace: '', kind: 'rule', id: 'rule-1' },
      evidence: { k: 8, n: 10, contextRejects: 0 },
      ema: { mu: 0.8, theta0: 0.5, updatedAt: 1000 },
      guard: { kind: 'ast', lastOk: true, lastOkAt: 1000 },
      anchors: [{ kind: 'git-head', value: 'sha-1' }],
      status: 'active',
      override: null,
      retiredAt: null,
      restoredAt: null,
      updater: 'ema',
      createdAt: 500,
      lastSignalAt: 1000,
    };

    const s2: EntityState = {
      key: { namespace: '', kind: 'rule', id: 'rule-1' },
      evidence: { k: 2, n: 10, contextRejects: 1 },
      ema: { mu: 0.4, theta0: 0.5, updatedAt: 2000 },
      guard: { kind: 'ast', lastOk: true, lastOkAt: 2000 },
      anchors: [{ kind: 'git-head', value: 'sha-2' }],
      status: 'probation',
      override: null,
      retiredAt: null,
      restoredAt: null,
      updater: 'ema',
      createdAt: 600,
      lastSignalAt: 2000,
    };

    const merged12 = mergeEntityStates([s1], [s2]);
    const merged21 = mergeEntityStates([s2], [s1]);

    expect(merged12).toEqual(merged21);
    expect(merged12).toHaveLength(1);

    const m = merged12[0];
    expect(m?.evidence.n).toBe(20);
    expect(m?.evidence.k).toBe(10);
    expect(m?.evidence.contextRejects).toBe(1);
    // (10 * 0.8 + 10 * 0.4) / 20 = 0.6
    expect(m?.ema.mu).toBe(0.6);
    expect(m?.ema.updatedAt).toBe(2000);
    expect(m?.createdAt).toBe(500);
    expect(m?.lastSignalAt).toBe(2000);
    expect(m?.anchors).toHaveLength(2);
  });
});
