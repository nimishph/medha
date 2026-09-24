import { describe, expect, test } from 'bun:test';
import type { Episode, EpisodeInput } from '@cntxt-labs/medha-core';
import { REJECT_CONTEXT, REJECT_RULE } from '@cntxt-labs/medha-core';
import { runStoreContractSuite, type StoreContractSetup } from '../contract-suite.ts';
import { MemoryStore } from '../memory-store.ts';

const HOST_SIGNAL = {
  name: 'ADOPTED',
  value: 0.6,
  countsAsTrial: true,
  countsAsSuccess: true,
} as const;

const EXTRA_KIND = 'locator';

const now = 1_700_000_000_000;

const setup: StoreContractSetup = {
  extraKind: EXTRA_KIND,
  hostSignal: HOST_SIGNAL,
  async create() {
    return new MemoryStore({
      registries: {
        kinds: [EXTRA_KIND],
        signalSpecs: [HOST_SIGNAL],
        anchorKinds: ['week'],
      },
    });
  },
  async createCorrupt() {
    const make = (seq: number, input: EpisodeInput): Episode => ({ ...input, seq }) as Episode;
    const now = 1_700_000_000_000;
    return new MemoryStore({
      registries: {
        kinds: [EXTRA_KIND],
        signalSpecs: [HOST_SIGNAL],
        anchorKinds: ['week'],
      },
      initialEpisodes: [
        make(0, {
          type: 'signal',
          key: { namespace: 'n', kind: 'rule', id: 'r1' },
          at: now,
          spec: REJECT_CONTEXT,
          ensure: true,
        }),
        make(1, {
          type: 'signal',
          key: { namespace: 'n', kind: 'rule', id: 'r1' },
          at: now + 1,
          spec: REJECT_RULE,
          ensure: true,
        }),
        // Log wobbles past seq 1: an episode whose key kind is not registered.
        make(2, {
          type: 'signal',
          key: { namespace: 'n', kind: 'mystery', id: 'r1' },
          at: now + 2,
          spec: REJECT_CONTEXT,
          ensure: true,
        }),
      ],
    });
  },
};

runStoreContractSuite(setup);

describe('memory store — fold-equivalence (§7.1)', () => {
  test('recomputed fold equals the projection for a long mixed log', async () => {
    const store = new MemoryStore({
      registries: { kinds: [EXTRA_KIND], signalSpecs: [HOST_SIGNAL], anchorKinds: ['week'] },
    });
    await store.open();

    for (let i = 0; i < 40; i++) {
      const input: EpisodeInput =
        i % 4 === 0
          ? {
              type: 'signal',
              key: { namespace: 'n', kind: EXTRA_KIND, id: 'x1' },
              at: now + i,
              spec: HOST_SIGNAL,
              ensure: true,
            }
          : i % 4 === 1
            ? {
                type: 'signal',
                key: { namespace: 'n', kind: 'rule', id: 'r1' },
                at: now + i,
                spec: REJECT_CONTEXT,
                ensure: true,
              }
            : i % 4 === 2
              ? {
                  type: 'guard',
                  key: { namespace: 'n', kind: 'rule', id: 'r1' },
                  at: now + i,
                  ok: i % 8 !== 2,
                  ensure: true,
                }
              : {
                  type: 'signal',
                  key: { namespace: 'n', kind: 'recipe', id: 'q1' },
                  at: now + i,
                  spec: REJECT_RULE,
                  ensure: true,
                };
      await store.append(input);
    }

    const listed = await store.list();
    const rebuilt = await store.rebuild();
    expect(rebuilt.length).toBeGreaterThan(0);
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(listed));
  });

  test('two independent rebuilds are identical and seq-stable', async () => {
    const store = new MemoryStore();
    await store.open();
    for (let i = 0; i < 25; i++) {
      await store.append({
        type: 'signal',
        key: { namespace: 'n', kind: 'rule', id: 'r1' },
        at: now + i,
        spec: i % 2 ? REJECT_RULE : REJECT_CONTEXT,
        ensure: true,
      });
    }
    const a = await store.rebuild();
    const b = await store.rebuild();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
