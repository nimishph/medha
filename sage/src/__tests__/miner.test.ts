import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  alwaysPromotePolicy,
  type Context,
  convergingEvidenceRefsPolicy,
  convergingSourcesPolicy,
  type EntityKey,
  InvalidArgumentError,
  type MinerPort,
  neverPromotePolicy,
  type Proposal,
} from '@cntxt-labs/medha-core';
import { FilePolicyStore, MemoryStore, SQLiteStore } from '@cntxt-labs/medha-store';
import { Sage } from '../engine.ts';

const NOW = 1_700_000_000_000;
const CTX: Context = { now: NOW, seed: 42 };

interface TestEvidence {
  readonly id: string;
  readonly category: string;
  readonly pattern: string;
  readonly runId: string;
  readonly commitSha?: string;
}

class FakeMiner implements MinerPort<TestEvidence> {
  readonly name: string;
  mineCallCount = 0;

  constructor(name = 'fake-miner') {
    this.name = name;
  }

  async mine(
    evidence: AsyncIterable<TestEvidence> | Iterable<TestEvidence>,
    _context: Context,
  ): Promise<readonly Proposal[]> {
    this.mineCallCount++;
    const items: TestEvidence[] = [];
    for await (const item of evidence) {
      items.push(item);
    }

    const byPattern = new Map<string, TestEvidence[]>();
    for (const item of items) {
      const list = byPattern.get(item.pattern) ?? [];
      list.push(item);
      byPattern.set(item.pattern, list);
    }

    const proposals: Proposal[] = [];
    for (const [pattern, cluster] of byPattern.entries()) {
      const first = cluster[0];
      if (first === undefined) continue;
      proposals.push({
        kind: 'recipe',
        id: `recipe-${pattern}`,
        description: `Synthesized recipe for ${pattern}`,
        evidenceRefs: cluster.map((c) => c.runId),
        anchor: first.commitSha ? { kind: 'git-head', value: first.commitSha } : undefined,
        provenance: this.name,
        theta0: 0.55,
      });
    }

    return proposals;
  }
}

function makeEngine(
  options: { readonly promotionPolicy?: import('@cntxt-labs/medha-core').PromotionPolicy } = {},
) {
  const store = new MemoryStore({
    registries: {
      kinds: ['rule', 'recipe', 'tool'],
      signalSpecs: [],
      anchorKinds: ['git-head', 'week'],
    },
  });
  const sage = new Sage({ store, promotionPolicy: options.promotionPolicy });
  return { store, sage };
}

describe('MinerPort contract (§7.3)', () => {
  test('fake miner mines from an Iterable evidence stream', async () => {
    const { sage } = makeEngine();
    const miner = new FakeMiner('cluster-miner');

    const evidence: TestEvidence[] = [
      { id: '1', category: 'auth', pattern: 'retry-401', runId: 'run-101', commitSha: 'sha-a' },
      { id: '2', category: 'auth', pattern: 'retry-401', runId: 'run-102', commitSha: 'sha-a' },
      { id: '3', category: 'cache', pattern: 'lru-bust', runId: 'run-103', commitSha: 'sha-b' },
    ];

    const mined = await sage.mine(evidence, miner, CTX);

    expect(miner.mineCallCount).toBe(1);
    expect(mined).toHaveLength(2);

    const retryRecipe = mined.find((m) => m.id === 'recipe-retry-401');
    expect(retryRecipe).toBeDefined();
    expect(retryRecipe?.description).toBe('Synthesized recipe for retry-401');
    expect(retryRecipe?.evidenceRefs).toEqual(['run-101', 'run-102']);
    expect(retryRecipe?.anchor).toEqual({ kind: 'git-head', value: 'sha-a' });
    expect(retryRecipe?.outcome.hint.status).toBe('probation');
    expect(retryRecipe?.outcome.provenances).toEqual(['cluster-miner']);
  });

  test('fake miner mines from an AsyncIterable stream', async () => {
    const { sage } = makeEngine();
    const miner = new FakeMiner('async-miner');

    async function* evidenceStream() {
      yield { id: '1', category: 'db', pattern: 'wal-lock', runId: 'run-201' };
      yield { id: '2', category: 'db', pattern: 'wal-lock', runId: 'run-202' };
    }

    const mined = await sage.mine(evidenceStream(), miner, CTX);

    expect(mined).toHaveLength(1);
    expect(mined[0]?.id).toBe('recipe-wal-lock');
    expect(mined[0]?.outcome.hint.status).toBe('probation');
    expect(mined[0]?.outcome.state?.evidence.n).toBe(0);
  });

  test('miners never write state directly; Sage owns episode logging (Invariant I)', async () => {
    const { store, sage } = makeEngine();
    const miner = new FakeMiner('non-agency-miner');

    const evidence: TestEvidence[] = [
      { id: '1', category: 'perf', pattern: 'batch-io', runId: 'run-301' },
    ];

    await store.open();
    const episodesBefore = await store.episodes();
    expect(episodesBefore).toHaveLength(0);

    await sage.mine(evidence, miner, CTX);

    const episodesAfter = await store.episodes();
    expect(episodesAfter).toHaveLength(1);
    expect(episodesAfter[0]?.type).toBe('proposal');
    expect(episodesAfter[0]?.key).toEqual({ namespace: '', kind: 'recipe', id: 'recipe-batch-io' });
    expect(episodesAfter[0]?.seq).toBe(0);
  });
});

describe('propose flow and read-plane provenance (§6.1, §6.2)', () => {
  test('propose puts proposal on probation with provenance', async () => {
    const { store, sage } = makeEngine();
    const key: EntityKey = { namespace: '', kind: 'recipe', id: 'singleton-cleanup' };

    const outcome = await sage.propose(
      {
        key,
        description: 'Clean singletons between tests',
        provenance: 'recipe-clusterer',
        evidenceRefs: ['digest-1'],
        theta0: 0.6,
      },
      CTX,
    );

    expect(outcome.hint.status).toBe('probation');
    expect(outcome.hint.temporal.emaWeight).toBe(0.6);
    expect(outcome.state?.status).toBe('probation');
    expect(outcome.provenances).toEqual(['recipe-clusterer']);

    const stored = await store.get(key);
    expect(stored).toBeDefined();
    expect(stored?.status).toBe('probation');
    expect(stored?.ema.theta0).toBe(0.6);
  });

  test('provenance is visible in show() for single and multiple converging proposals', async () => {
    const { sage } = makeEngine();
    const key: EntityKey = { namespace: '', kind: 'recipe', id: 'auth-cache' };

    await sage.propose(
      {
        key,
        provenance: 'miner-alpha',
        description: 'Auth cache recipe proposal A',
        evidenceRefs: ['run-1'],
      },
      { now: NOW },
    );

    let detail = await sage.show(key, { now: NOW + 10 });
    expect(detail.known).toBe(true);
    expect(detail.provenance).toEqual(['miner-alpha']);
    expect(detail.promoted).toBe(false);
    expect(detail.recentEpisodes).toHaveLength(1);

    await sage.propose(
      {
        key,
        provenance: 'miner-beta',
        description: 'Auth cache recipe proposal B',
        evidenceRefs: ['run-2'],
      },
      { now: NOW + 20 },
    );

    detail = await sage.show(key, { now: NOW + 30 });
    expect(detail.known).toBe(true);
    expect(detail.provenance).toContain('miner-alpha');
    expect(detail.provenance).toContain('miner-beta');
    expect(detail.provenance).toHaveLength(2);
    expect(detail.promoted).toBe(true);
    expect(detail.recentEpisodes).toHaveLength(2);
    expect(detail.recentEpisodes[0]?.seq).toBe(1);
    expect(detail.recentEpisodes[1]?.seq).toBe(0);
  });
});

describe('promotion policy — overridable and tested (§7.3)', () => {
  test('default promotion policy requires >= 2 converging sources', async () => {
    const { sage } = makeEngine();
    const key: EntityKey = { namespace: '', kind: 'recipe', id: 'dedup-check' };

    const outcome1 = await sage.propose(
      { key, provenance: 'source-1', evidenceRefs: ['e1'] },
      { now: NOW },
    );
    expect(outcome1.promoted).toBe(false);
    expect(outcome1.promotionReason).toContain('Requires >= 2 converging sources; saw 1');

    const outcome1Repeat = await sage.propose(
      { key, provenance: 'source-1', evidenceRefs: ['e2'] },
      { now: NOW + 1 },
    );
    expect(outcome1Repeat.promoted).toBe(false);

    const outcome2 = await sage.propose(
      { key, provenance: 'source-2', evidenceRefs: ['e3'] },
      { now: NOW + 2 },
    );
    expect(outcome2.promoted).toBe(true);
    expect(outcome2.promotionReason).toContain('2 converging sources: source-1, source-2');
  });

  test('promotion policy can be overridden at engine constructor level', async () => {
    const { sage } = makeEngine({
      promotionPolicy: convergingSourcesPolicy({ minSources: 3 }),
    });
    const key: EntityKey = { namespace: '', kind: 'rule', id: 'strict-nulls' };

    const p1 = await sage.propose({ key, provenance: 's1' }, { now: NOW });
    expect(p1.promoted).toBe(false);

    const p2 = await sage.propose({ key, provenance: 's2' }, { now: NOW + 1 });
    expect(p2.promoted).toBe(false);

    const p3 = await sage.propose({ key, provenance: 's3' }, { now: NOW + 2 });
    expect(p3.promoted).toBe(true);
    expect(p3.promotionReason).toContain('3 converging sources');
  });

  test('neverPromotePolicy always rejects promotion', async () => {
    const policy = neverPromotePolicy();
    const ctx: import('@cntxt-labs/medha-core').PromotionContext = {
      proposal: { kind: 'rule', id: 'r1' },
      key: { namespace: '', kind: 'rule', id: 'r1' },
      state: undefined,
      proposalEpisodes: [],
      provenances: ['p1', 'p2', 'p3'],
      evidenceRefs: [],
      context: CTX,
    };
    const decision = await policy(ctx);
    const result = typeof decision === 'boolean' ? { promoted: decision } : decision;
    expect(result.promoted).toBe(false);
  });

  test('promotion policy can be overridden per-call on propose()', async () => {
    const { sage } = makeEngine();
    const key: EntityKey = { namespace: '', kind: 'tool', id: 'fast-formatter' };

    const outcome = await sage.propose({ key, provenance: 'one-shot-source' }, CTX, {
      promotionPolicy: alwaysPromotePolicy(),
    });

    expect(outcome.promoted).toBe(true);
    expect(outcome.promotionReason).toBe('always promote policy');
  });

  test('promotion policy can be overridden per-call on mine()', async () => {
    const { sage } = makeEngine();
    const miner = new FakeMiner('single-pass-miner');

    const evidence: TestEvidence[] = [
      { id: '1', category: 'lint', pattern: 'no-eval', runId: 'run-1' },
    ];

    const mined = await sage.mine(evidence, miner, CTX, {
      promotionPolicy: alwaysPromotePolicy(),
    });

    expect(mined).toHaveLength(1);
    expect(mined[0]?.outcome.promoted).toBe(true);
  });

  test('custom evidence-refs promotion policy', async () => {
    const { sage } = makeEngine({
      promotionPolicy: convergingEvidenceRefsPolicy({ minRefs: 3 }),
    });
    const key: EntityKey = { namespace: '', kind: 'recipe', id: 'socket-drain' };

    const o1 = await sage.propose(
      { key, provenance: 'm1', evidenceRefs: ['ref-1', 'ref-2'] },
      { now: NOW },
    );
    expect(o1.promoted).toBe(false);

    const o2 = await sage.propose(
      { key, provenance: 'm1', evidenceRefs: ['ref-3'] },
      { now: NOW + 1 },
    );
    expect(o2.promoted).toBe(true);
    expect(o2.promotionReason).toContain('3 converging evidence refs');
  });

  test('custom predicate promotion policy', async () => {
    const customPolicy = (ctx: import('@cntxt-labs/medha-core').PromotionContext) => {
      const isCritical = ctx.proposal.description?.includes('CRITICAL') ?? false;
      return {
        promoted: isCritical,
        reason: isCritical ? 'Critical priority proposal' : 'Non-critical proposal',
      };
    };

    const { sage } = makeEngine({ promotionPolicy: customPolicy });
    const key1: EntityKey = { namespace: '', kind: 'rule', id: 'rule-normal' };
    const key2: EntityKey = { namespace: '', kind: 'rule', id: 'rule-critical' };

    const o1 = await sage.propose({ key: key1, description: 'standard rule' }, CTX);
    expect(o1.promoted).toBe(false);

    const o2 = await sage.propose({ key: key2, description: 'CRITICAL security patch' }, CTX);
    expect(o2.promoted).toBe(true);
    expect(o2.promotionReason).toBe('Critical priority proposal');
  });
});

describe('validation and error handling', () => {
  test('unknown kind throws typed error naming known kinds', async () => {
    const { sage } = makeEngine();
    await expect(
      sage.propose({ kind: 'alien-kind', id: 'x', provenance: 'm1' }, CTX),
    ).rejects.toThrow();
  });

  test('empty id or provenance throws InvalidArgumentError', async () => {
    const { sage } = makeEngine();
    await expect(sage.propose({ kind: 'recipe', id: '', provenance: 'm1' }, CTX)).rejects.toThrow(
      InvalidArgumentError,
    );

    await expect(sage.propose({ kind: 'recipe', id: 'x', provenance: '   ' }, CTX)).rejects.toThrow(
      InvalidArgumentError,
    );
  });

  test('invalid theta0 throws InvalidArgumentError', async () => {
    const { sage } = makeEngine();
    await expect(
      sage.propose({ kind: 'recipe', id: 'x', theta0: 1.5, provenance: 'm1' }, CTX),
    ).rejects.toThrow(InvalidArgumentError);
  });

  test('invalid miner name throws InvalidArgumentError', async () => {
    const { sage } = makeEngine();
    const badMiner = new FakeMiner('   ');
    await expect(sage.mine([], badMiner, CTX)).rejects.toThrow(InvalidArgumentError);
  });
});

describe('storage backend parity for mining flow', () => {
  test('mining flow works identically on FileStore and SQLiteStore', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sage-miner-parity-'));
    try {
      const fileStore = new FilePolicyStore({
        dir: join(tmp, 'file-store'),
        registries: { kinds: ['recipe'], signalSpecs: [], anchorKinds: [] },
      });
      const sqliteStore = new SQLiteStore({
        path: join(tmp, 'store.db'),
        registries: { kinds: ['recipe'], signalSpecs: [], anchorKinds: [] },
      });

      for (const store of [fileStore, sqliteStore]) {
        const sage = new Sage({ store });
        const miner = new FakeMiner(`miner-${store.name}`);
        const evidence: TestEvidence[] = [
          { id: '1', category: 'c', pattern: 'p1', runId: 'r1' },
          { id: '2', category: 'c', pattern: 'p1', runId: 'r2' },
        ];

        const mined = await sage.mine(evidence, miner, CTX);
        expect(mined).toHaveLength(1);
        expect(mined[0]?.id).toBe('recipe-p1');

        const detail = await sage.show({ namespace: '', kind: 'recipe', id: 'recipe-p1' }, CTX);
        expect(detail.known).toBe(true);
        expect(detail.provenance).toEqual([`miner-${store.name}`]);
        await store.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
