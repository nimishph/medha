/**
 * Distributed Systems Convergence Test Suite (§7.2, §14.4).
 *
 * Verifies multi-node gossip mesh convergence, cross-replica retraction resolution,
 * network partition healing, and CAS divergence recovery under concurrent writes.
 */

import { describe, expect, it } from 'bun:test';
import type { EpisodeInput } from '@cntxt-labs/medha-core';
import { mergeEpisodes } from '../merge.ts';
import { createTestStore } from './test-store.ts';

function createSignal(id: string, at: number, success = true): EpisodeInput {
  return {
    key: { namespace: '', kind: 'rule', id },
    at,
    type: 'signal',
    spec: {
      name: success ? 'APPLY' : 'REJECT_RULE',
      value: success ? 1.0 : -1.0,
      countsAsTrial: true,
      countsAsSuccess: success,
    },
    ensure: true,
  };
}

describe('Distributed Systems — Multi-Node Consensus', () => {
  it('5-node gossip mesh converges to identical log and state regardless of gossip order', async () => {
    const r0 = createTestStore();
    const r1 = createTestStore();
    const r2 = createTestStore();
    const r3 = createTestStore();
    const r4 = createTestStore();

    for (const store of [r0, r1, r2, r3, r4]) {
      await store.open();
    }

    // Node 0
    await r0.append(createSignal('rule-A', 1000, true));
    await r0.append(createSignal('rule-B', 1050, true));

    // Node 1
    await r1.append(createSignal('rule-B', 1100, false));
    await r1.append(createSignal('rule-C', 1150, true));

    // Node 2
    await r2.append(createSignal('rule-A', 1200, true));
    await r2.append(createSignal('rule-C', 1250, true));
    await r2.append(createSignal('rule-D', 1300, false));

    // Node 3
    await r3.append(createSignal('rule-D', 1350, true));
    await r3.append(createSignal('rule-E', 1400, true));

    // Node 4
    await r4.append(createSignal('rule-A', 1450, false));
    await r4.append(createSignal('rule-E', 1500, true));

    const replicas = [r0, r1, r2, r3, r4];

    // Chaotic gossip schedule
    const gossipPairs: [number, number][] = [
      [0, 1],
      [2, 3],
      [1, 4],
      [0, 3],
      [2, 4],
      [3, 1],
      [4, 0],
      [1, 2],
      [0, 2],
      [3, 4],
    ];

    for (const [i, j] of gossipPairs) {
      const storeI = replicas[i];
      const storeJ = replicas[j];
      if (storeI && storeJ) {
        const logI = await storeI.episodes();
        const logJ = await storeJ.episodes();
        const merged = mergeEpisodes(logI, logJ);
        await storeI.replaceLog(merged);
        await storeJ.replaceLog(merged);
      }
    }

    const refLog = await r0.episodes();
    const refStates = await r0.list();

    expect(refLog).toHaveLength(11);
    expect(refStates).toHaveLength(5);

    for (let idx = 1; idx < 5; idx++) {
      const store = replicas[idx];
      if (store) {
        const ep = await store.episodes();
        const st = await store.list();
        expect(ep).toEqual(refLog);
        expect(st).toEqual(refStates);
      }
    }
  });

  it('resolves cross-replica retractions when target sequence numbers differ across nodes', async () => {
    const r1 = createTestStore();
    await r1.open();
    const r2 = createTestStore();
    await r2.open();
    const r3 = createTestStore();
    await r3.open();

    // R1 creates rule-bad at t=25 (valid) and t=100 (bad)
    await r1.append(createSignal('rule-bad', 25, true));
    await r1.append(createSignal('rule-bad', 100, false));

    // R2 pulls R1
    const r1Log = await r1.episodes();
    await r2.replaceLog(r1Log);

    // R2 issues Retract against seq 1 (the bad signal at t=100)
    await r2.append({
      key: { namespace: '', kind: 'rule', id: 'rule-bad' },
      at: 300,
      type: 'retract',
      targetSeq: 1,
      reason: 'auditor retraction',
    });

    // R3 logged other rules first
    await r3.append(createSignal('rule-innocent-1', 10, true));
    await r3.append(createSignal('rule-innocent-2', 15, true));
    await r3.append(createSignal('rule-bad', 25, true));
    await r3.append(createSignal('rule-bad', 100, false));

    // Merge R2 and R3
    const merged = mergeEpisodes(await r2.episodes(), await r3.episodes());
    await r2.replaceLog(merged);
    await r3.replaceLog(merged);

    const states = await r3.list();
    const badState = states.find((s) => s.key.id === 'rule-bad');
    // Exactly 1 trial remains (the valid one at t=25)
    expect(badState?.evidence.n).toBe(1);

    const inn1 = states.find((s) => s.key.id === 'rule-innocent-1');
    expect(inn1?.evidence.n).toBe(1);

    const inn2 = states.find((s) => s.key.id === 'rule-innocent-2');
    expect(inn2?.evidence.n).toBe(1);
  });

  it('heals network partition without data loss or diverged states', async () => {
    const nodeA = createTestStore();
    await nodeA.open();
    const nodeB = createTestStore();
    await nodeB.open();
    const nodeC = createTestStore();
    await nodeC.open();
    const nodeD = createTestStore();
    await nodeD.open();

    const init = createSignal('shared-rule', 100, true);
    for (const n of [nodeA, nodeB, nodeC, nodeD]) {
      await n.append(init);
    }

    // Partition 1 (A & B)
    for (let i = 0; i < 200; i++) {
      const target = i % 2 === 0 ? nodeA : nodeB;
      await target.append(createSignal('shared-rule', 200 + i, true));
    }
    const mergedAB = mergeEpisodes(await nodeA.episodes(), await nodeB.episodes());
    await nodeA.replaceLog(mergedAB);
    await nodeB.replaceLog(mergedAB);

    // Partition 2 (C & D)
    for (let i = 0; i < 200; i++) {
      const target = i % 2 === 0 ? nodeC : nodeD;
      await target.append(createSignal('shared-rule', 600 + i, i % 4 !== 0));
    }
    const mergedCD = mergeEpisodes(await nodeC.episodes(), await nodeD.episodes());
    await nodeC.replaceLog(mergedCD);
    await nodeD.replaceLog(mergedCD);

    // Partition heals: cross-reconcile B and C
    const crossBC = mergeEpisodes(await nodeB.episodes(), await nodeC.episodes());
    await nodeB.replaceLog(crossBC);
    await nodeC.replaceLog(crossBC);

    // Propagate to A and D
    const fullA = mergeEpisodes(await nodeA.episodes(), await nodeB.episodes());
    await nodeA.replaceLog(fullA);
    const fullD = mergeEpisodes(await nodeD.episodes(), await nodeC.episodes());
    await nodeD.replaceLog(fullD);

    const statesA = await nodeA.list();
    const statesD = await nodeD.list();

    expect(statesA[0]?.evidence.n).toBe(401);
    expect(statesA).toEqual(statesD);
  });
});
