import { describe, expect, test } from 'bun:test';
import { MemoryStore } from '@cntxt-labs/medha-store';
import { Medha } from '../engine.ts';

const NOW = 1_700_000_000_000;

describe('Medha engine.pack', () => {
  test('packs matching entities from store into budget', async () => {
    const store = new MemoryStore();
    const engine = new Medha({ store });
    await engine.open({ now: NOW });

    // Seed 3 rules
    await engine.record(
      { namespace: '', kind: 'rule', id: 'rule-high' },
      'APPLY',
      { now: NOW },
      { ensure: true },
    );
    await engine.record({ namespace: '', kind: 'rule', id: 'rule-high' }, 'APPLY', {
      now: NOW + 10,
    });
    await engine.record({ namespace: '', kind: 'rule', id: 'rule-high' }, 'APPLY', {
      now: NOW + 20,
    });

    await engine.record(
      { namespace: '', kind: 'rule', id: 'rule-mid' },
      'APPLY',
      { now: NOW },
      { ensure: true },
    );

    await engine.record(
      { namespace: '', kind: 'tool', id: 'tool-other' },
      'APPLY',
      { now: NOW },
      { ensure: true },
    );

    // Pack with kind: 'rule'
    const outcome = await engine.pack({ budget: 500, kind: 'rule' }, { now: NOW + 100 });
    expect(outcome.selected.length).toBeGreaterThan(0);
    // All selected items must be rules
    for (const item of outcome.selected) {
      expect(item.key.kind).toBe('rule');
    }
    expect(outcome.totalCost).toBeLessThanOrEqual(500);
    expect(outcome.remainingBudget).toBeGreaterThanOrEqual(0);
  });

  test('packs explicit candidates with custom costs and payloads', async () => {
    const store = new MemoryStore();
    const engine = new Medha({ store });
    await engine.open({ now: NOW });

    await engine.record(
      { namespace: '', kind: 'rule', id: 'r1' },
      'APPLY',
      { now: NOW },
      { ensure: true },
    );
    await engine.record(
      { namespace: '', kind: 'rule', id: 'r2' },
      'APPLY',
      { now: NOW },
      { ensure: true },
    );

    const outcome = await engine.pack<{ prompt: string }>(
      {
        budget: 150,
        candidates: [
          {
            key: { namespace: '', kind: 'rule', id: 'r1' },
            cost: 100,
            mandatory: true,
            payload: { prompt: 'Always use strict TypeScript types' },
          },
          {
            key: { namespace: '', kind: 'rule', id: 'r2' },
            cost: 80,
            payload: { prompt: 'Prefer functional composition' },
          },
        ],
      },
      { now: NOW + 100 },
    );

    // Budget 150: mandatory r1 (100) fits, leaving 50. r2 (80) does not fit.
    expect(outcome.selected).toHaveLength(1);
    expect(outcome.selected[0]?.key.id).toBe('r1');
    expect(outcome.selected[0]?.payload?.prompt).toBe('Always use strict TypeScript types');
    expect(outcome.selected[0]?.admittedBy).toBe('mandatory');
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0]?.key.id).toBe('r2');
  });
});
