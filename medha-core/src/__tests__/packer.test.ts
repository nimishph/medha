import { describe, expect, test } from 'bun:test';
import type { EntityKey, EvidentialHint } from '../index.ts';
import { InvalidArgumentError } from '../index.ts';
import { type PackCandidate, packEntities } from '../packer.ts';

function makeKey(id: string, kind = 'rule'): EntityKey {
  return { namespace: '', kind, id };
}

function makeHint(
  id: string,
  trustScore: number,
  status: 'probation' | 'active' | 'trusted' | 'quarantined' | 'retired' = 'active',
  successes = 10,
  totalTrials = 10,
): EvidentialHint {
  return {
    asOf: 1_700_000_000_000,
    key: makeKey(id),
    status,
    trustScore,
    components: {
      wilson: trustScore,
      guard: 1.0,
      recency: 1.0,
      durability: 1.0,
      ceiling: 1.0,
    },
    evidence: {
      successes,
      totalTrials,
      lowerBound: trustScore * 0.8,
    },
    temporal: {
      emaWeight: trustScore,
      driftDelta: 0,
      isDrifting: false,
    },
    clearsThreshold: {
      trusted: status === 'trusted',
      active: status === 'active' || status === 'trusted',
    },
  };
}

describe('medha-core packEntities', () => {
  test('handles zero budget or empty candidates gracefully', () => {
    const candidate: PackCandidate = {
      key: makeKey('r1'),
      hint: makeHint('r1', 0.9),
      cost: 100,
    };

    const emptyOutcome = packEntities([], { budget: 1000 });
    expect(emptyOutcome.selected).toHaveLength(0);
    expect(emptyOutcome.utilization).toBe(0);
    expect(emptyOutcome.totalCost).toBe(0);

    const zeroBudget = packEntities([candidate], { budget: 0 });
    expect(zeroBudget.selected).toHaveLength(0);
    expect(zeroBudget.rejected).toHaveLength(1);
    expect(zeroBudget.totalCost).toBe(0);
  });

  test('prioritizes mandatory items first', () => {
    const items: PackCandidate[] = [
      {
        key: makeKey('mandatory-low-trust'),
        hint: makeHint('mandatory-low-trust', 0.3),
        cost: 200,
        mandatory: true,
      },
      {
        key: makeKey('high-trust-merit'),
        hint: makeHint('high-trust-merit', 0.95),
        cost: 200,
      },
      {
        key: makeKey('medium-trust-merit'),
        hint: makeHint('medium-trust-merit', 0.7),
        cost: 200,
      },
    ];

    // Budget of 300 only fits mandatory (200) + one item of 200 won't fit (needs 400).
    const outcome = packEntities(items, { budget: 300 });
    expect(outcome.selected).toHaveLength(1);
    expect(outcome.selected[0]?.key.id).toBe('mandatory-low-trust');
    expect(outcome.selected[0]?.admittedBy).toBe('mandatory');
    expect(outcome.totalCost).toBe(200);
    expect(outcome.remainingBudget).toBe(100);
  });

  test('rejects mandatory items that exceed total budget', () => {
    const items: PackCandidate[] = [
      {
        key: makeKey('huge-mandatory'),
        hint: makeHint('huge-mandatory', 0.8),
        cost: 600,
        mandatory: true,
      },
      {
        key: makeKey('small-merit'),
        hint: makeHint('small-merit', 0.9),
        cost: 200,
      },
    ];

    const outcome = packEntities(items, { budget: 400 });
    expect(outcome.selected).toHaveLength(1);
    expect(outcome.selected[0]?.key.id).toBe('small-merit');
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0]?.key.id).toBe('huge-mandatory');
  });

  test('packs merit items by density (trust / cost)', () => {
    const items: PackCandidate[] = [
      // Density = 0.8 / 100 = 0.008
      { key: makeKey('efficient'), hint: makeHint('efficient', 0.8), cost: 100 },
      // Density = 0.9 / 300 = 0.003
      { key: makeKey('costly'), hint: makeHint('costly', 0.9), cost: 300 },
      // Density = 0.6 / 100 = 0.006
      { key: makeKey('medium'), hint: makeHint('medium', 0.6), cost: 100 },
    ];

    // Budget: 200 tokens
    // Efficient (100) + Medium (100) = 200 tokens, total trust = 1.4
    // Costly (300) does not fit
    const outcome = packEntities(items, { budget: 200 });
    expect(outcome.selected).toHaveLength(2);
    expect(outcome.selected[0]?.key.id).toBe('efficient');
    expect(outcome.selected[1]?.key.id).toBe('medium');
    expect(outcome.totalCost).toBe(200);
    expect(outcome.utilization).toBe(1);
  });

  test('reserves exploration budget for probation candidates', () => {
    const items: PackCandidate[] = [
      { key: makeKey('merit1'), hint: makeHint('merit1', 0.95, 'trusted'), cost: 300 },
      { key: makeKey('merit2'), hint: makeHint('merit2', 0.9, 'trusted'), cost: 300 },
      {
        key: makeKey('prob1'),
        hint: makeHint('prob1', 0.5, 'probation', 1, 2),
        cost: 200,
      },
    ];

    // Budget = 1000. Exploration ratio = 0.25 (250 tokens reserved for probation).
    // prob1 (200 tokens) fits in 250 exploration budget!
    const outcome = packEntities(items, {
      budget: 1000,
      explorationRatio: 0.25,
      seed: 42,
    });

    const probationSelected = outcome.selected.filter((s) => s.admittedBy === 'probation');
    expect(probationSelected).toHaveLength(1);
    expect(probationSelected[0]?.key.id).toBe('prob1');
    expect(outcome.probationCount).toBe(1);
  });

  test('cascades unused exploration budget back to merit packing', () => {
    const items: PackCandidate[] = [
      { key: makeKey('m1'), hint: makeHint('m1', 0.9, 'trusted'), cost: 500 },
      { key: makeKey('m2'), hint: makeHint('m2', 0.85, 'trusted'), cost: 400 },
    ];

    // No probation items exist, but exploration ratio is 0.3.
    // Full budget 1000 should be available to merit items (500 + 400 = 900)
    const outcome = packEntities(items, { budget: 1000, explorationRatio: 0.3 });
    expect(outcome.selected).toHaveLength(2);
    expect(outcome.totalCost).toBe(900);
  });

  test('filters out quarantined and retired entities by default', () => {
    const items: PackCandidate[] = [
      { key: makeKey('active'), hint: makeHint('active', 0.8, 'active'), cost: 100 },
      { key: makeKey('quarantined'), hint: makeHint('quarantined', 0.2, 'quarantined'), cost: 100 },
      { key: makeKey('retired'), hint: makeHint('retired', 0.1, 'retired'), cost: 100 },
    ];

    const defaultOutcome = packEntities(items, { budget: 500 });
    expect(defaultOutcome.selected).toHaveLength(1);
    expect(defaultOutcome.selected[0]?.key.id).toBe('active');
    expect(defaultOutcome.rejected).toHaveLength(2);

    const permissiveOutcome = packEntities(items, {
      budget: 500,
      allowQuarantined: true,
      allowRetired: true,
    });
    expect(permissiveOutcome.selected).toHaveLength(3);
  });

  test('throws typed InvalidArgumentError on invalid budget or cost', () => {
    expect(() => packEntities([], { budget: -10 })).toThrow(InvalidArgumentError);
    expect(() =>
      packEntities([{ key: makeKey('bad'), hint: makeHint('bad', 0.5), cost: -50 }], {
        budget: 100,
      }),
    ).toThrow(InvalidArgumentError);
    expect(() => packEntities([], { budget: 100, explorationRatio: 1.5 })).toThrow(
      InvalidArgumentError,
    );
  });
});
