import { describe, expect, test } from 'bun:test';
import {
  type EntityKey,
  foldDecisionTree,
  foldLog,
  InvalidArgumentError,
  KindRegistry,
  PermissionDeniedError,
} from '@cntxt-labs/medha-core';
import { MemoryStore } from '@cntxt-labs/medha-store';
import { Medha } from '../engine.ts';

/**
 * Write plane (§6.2) acceptance: every mutation writes an episode; the weight-updater runs through
 * the registry and its EMA fallback is *reported*; override transitions are recorded; a guard
 * report changes G (and trust/status) but Medha executes nothing else.
 */

const NOW = 1_700_000_000_000;
const KEY: EntityKey = { namespace: 'ns', kind: 'rule', id: 'r1' };
const ctx = { now: NOW };
const HOST_KIND = 'host';

function makeEngine() {
  const store = new MemoryStore({
    registries: { kinds: [HOST_KIND], signalSpecs: [], anchorKinds: ['week'] },
  });
  return { store, medha: new Medha({ store }) };
}

// Register each custom updater with a distinct weight so the registry route is unambiguous.
function fixedUpdater(name: string, newWeight: number) {
  return { name, computeWeight: () => ({ newWeight }) };
}

describe('write plane — record (§6.2)', () => {
  test('writes an episode for every signal and returns the new hint plus updater usage', async () => {
    const { store, medha } = makeEngine();
    const out = await medha.record(KEY, 'APPLY', ctx, {
      ensure: true,
      runRef: 'run-1',
      note: 'ran twice in CI',
    });
    expect(out.updater?.name).toBe('ema');
    expect(out.hint.evidence.successes).toBe(1);
    expect(out.state?.ema.mu).toBe(0.55);

    const log = await store.episodes();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      type: 'signal',
      ensure: true,
      runRef: 'run-1',
      note: 'ran twice in CI',
    });
    expect((log[0] as { updater?: string }).updater).toBe('ema');
    expect((log[0] as { weight?: number }).weight).toBe(0.55);
  });

  test('records a signal with an anchor and returns the growth it produced', async () => {
    const { medha } = makeEngine();
    const out = await medha.record(KEY, 'REJECT_RULE', ctx, {
      ensure: true,
      anchor: { kind: 'git', value: 'abc1234' },
    });
    expect(out.state?.evidence.n).toBe(1);
    // Rejections are not successes, and an anchor is only kept on a successful use.
    expect(out.state?.evidence.k).toBe(0);
    expect(out.state?.anchors).toEqual([]);
    // REJECT_RULE (−1.0) from the 0.5 prior lands on emaStep(0.5, −1) = 0.9·0.5 − 0.1 = 0.35.
    expect(out.hint.temporal.emaWeight).toBe(0.35);
  });

  test('a signal with an anchor on a success is durable', async () => {
    const { medha } = makeEngine();
    const out = await medha.record(KEY, 'APPLY', ctx, {
      ensure: true,
      anchor: { kind: 'git', value: 'abc1234' },
    });
    expect(out.state?.anchors).toEqual([{ kind: 'git', value: 'abc1234' }]);
  });

  test('an un-ensured signal on an unknown id is a logged no-op (spec §5.2)', async () => {
    const { store, medha } = makeEngine();
    const out = await medha.record({ namespace: '', kind: 'tool', id: 'never' }, 'APPLY', ctx);
    expect(out.state).toBeUndefined();
    expect(out.updater).toBeUndefined();
    expect(out.hint.status).toBe('probation');
    expect(await store.episodes()).toHaveLength(1);
  });

  test('a custom updater is reachable from the write path — not just the four built-ins', async () => {
    const { store, medha } = makeEngine();
    medha.updaters.register(fixedUpdater('fixed-delta', 0.99), 'project');
    const out = await medha.record(KEY, 'APPLY', ctx, { ensure: true, updater: 'fixed-delta' });
    expect(out.updater?.name).toBe('fixed-delta');
    expect(out.hint.temporal.emaWeight).toBe(0.99);
    expect(out.state?.ema.mu).toBe(0.99);

    // Fold-equivalence holds: the embedded weight is self-describing in the episode.
    const rebuilt = await store.rebuild();
    expect(rebuilt[0]?.ema.mu).toBe(0.99);
  });

  test('an updater that throws falls back to EMA and the fallback is reported', async () => {
    const { medha } = makeEngine();
    medha.updaters.register(
      {
        name: 'buggy',
        computeWeight: () => {
          throw new InvalidArgumentError('simulated crash', 'n/a', 'n/a');
        },
      },
      'project',
    );
    const out = await medha.record(KEY, 'APPLY', ctx, { ensure: true, updater: 'buggy' });
    expect(out.updater?.name).toBe('ema');
    expect(out.updater?.fallbackFrom).toBe('buggy');
    expect(out.updater?.error).toBeDefined();
    expect(out.hint.temporal.emaWeight).toBe(0.55);
  });

  test('the entity-level updater is honoured when record does not override it', async () => {
    const { medha } = makeEngine();
    // Host ships its belief about the strategy per kind; the engine reads state.updater.
    const out = await medha.record(KEY, 'APPLY', ctx, {
      ensure: true,
      updater: 'asymmetric-penalty',
    });
    expect(out.updater?.name).toBe('asymmetric-penalty');
    expect(out.state?.ema.mu).toBeCloseTo(0.52, 6); // 0.5 + 0.04*(1-0.5)
  });
});

describe('write plane — reportGuard (§6.2)', () => {
  test('changes G and therefore trust, appending exactly one episode — executes nothing', async () => {
    const { store, medha } = makeEngine();
    await medha.record(KEY, 'APPLY', ctx, { ensure: true });
    await medha.record(KEY, 'APPLY', { now: NOW + 1 });
    const before = await medha.hints([KEY], { now: NOW + 2 });

    const after = await medha.reportGuard(KEY, { ok: true, kind: 'harness-ast' }, { now: NOW + 3 });
    expect(after.components.guard).toBe(1);
    expect(before.get(entityKey(KEY))?.components.guard).toBe(0.5);
    expect(after.components.guard).toBeGreaterThan(
      before.get(entityKey(KEY))?.components.guard ?? 0,
    );

    // Exactly the guard episode was added; no signal, no sweep, nothing else executed.
    const log = await store.episodes();
    expect(log).toHaveLength(3);
    expect(log[2]).toMatchObject({ type: 'guard', ok: true, kind: 'harness-ast' });
  });

  test('a failed guard zeroes G and quarantines the entity', async () => {
    const { medha } = makeEngine();
    await medha.record(KEY, 'APPLY', ctx, { ensure: true });
    const hint = await medha.reportGuard(KEY, { ok: false, kind: 'harness-ast' }, { now: NOW + 1 });
    expect(hint.components.guard).toBe(0);
    expect(hint.status).toBe('quarantined');
    expect(hint.trustScore).toBe(0);
  });

  test('report.at overrides context.now as the episode clock (determinism preserved)', async () => {
    const { medha } = makeEngine();
    await medha.record(KEY, 'APPLY', { now: NOW }, { ensure: true });
    const hint = await medha.reportGuard(
      KEY,
      { ok: true, at: NOW + 5000, kind: 'harness-ast' },
      { now: NOW },
    );
    expect(hint.asOf).toBe(NOW);
    expect((await medha.store.episodes())[1]?.at).toBe(NOW + 5000);
    expect(hint.components.guard).toBe(1);
  });
});

describe('write plane — override (§6.2)', () => {
  test('records the override episode and transitions the lifecycle', async () => {
    const { store, medha } = makeEngine();
    await medha.record(KEY, 'APPLY', ctx, { ensure: true });
    await medha.record(KEY, 'APPLY', { now: NOW + 1 });

    const hint = await medha.override(
      KEY,
      'retire',
      { now: NOW + 2 },
      'deprecated in favour of v2',
    );
    expect(hint).not.toBeNull();
    expect(hint?.status).toBe('retired');
    expect(hint?.trustScore).toBe(0);

    const log = await store.episodes();
    expect(log[log.length - 1]).toMatchObject({
      type: 'override',
      override: 'retired',
      reason: 'deprecated in favour of v2',
    });
  });

  test('quarantine and restore both transition cleanly', async () => {
    const { medha } = makeEngine();
    await medha.record(KEY, 'APPLY', ctx, { ensure: true });
    const quarantined = await medha.override(KEY, 'quarantine', { now: NOW + 1 }, 'incident');
    expect(quarantined?.status).toBe('quarantined');
    const restored = await medha.override(KEY, 'restore', { now: NOW + 2 }, 'resolved');
    expect(restored?.status).toBe('probation');
  });

  test('an override on an unknown entity is a logged no-op returning null', async () => {
    const { store, medha } = makeEngine();
    const result = await medha.override(
      { namespace: '', kind: 'tool', id: 'missing' },
      'retire',
      ctx,
      'x',
    );
    expect(result).toBeNull();
    const log = await store.episodes();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ type: 'override' });
    expect(await medha.store.get({ namespace: '', kind: 'tool', id: 'missing' })).toBeUndefined();
  });
});

describe('write plane — authorship and permissions (§6.2)', () => {
  test('records author provenance on signal, guard, and override episodes', async () => {
    const { store, medha } = makeEngine();
    await medha.record(KEY, 'APPLY', { now: NOW }, { ensure: true, author: 'agent:claude-3-7' });
    await medha.reportGuard(KEY, { ok: true, author: 'reviewer:bob' }, { now: NOW + 1 });
    await medha.override(KEY, 'retire', { now: NOW + 2 }, 'obsolete', 'user:admin');

    const log = await store.episodes();
    expect(log[0]?.author).toBe('agent:claude-3-7');
    expect(log[1]?.author).toBe('reviewer:bob');
    expect(log[2]?.author).toBe('user:admin');
  });

  test('enforces write permissions: readOnly and requireAuthor', async () => {
    const { store } = makeEngine();
    const readOnlyMedha = new Medha({
      store,
      permissions: { readOnly: true },
    });
    expect(() =>
      readOnlyMedha.record(KEY, 'APPLY', { now: NOW }, { ensure: true, author: 'agent:1' }),
    ).toThrow();

    const requireAuthorMedha = new Medha({
      store,
      permissions: { requireAuthor: true },
    });
    expect(() => requireAuthorMedha.record(KEY, 'APPLY', { now: NOW }, { ensure: true })).toThrow();
    // With author, it succeeds
    await requireAuthorMedha.record(
      KEY,
      'APPLY',
      { now: NOW },
      { ensure: true, author: 'agent:1' },
    );
  });

  test('enforces allowedAuthors list', async () => {
    const { store } = makeEngine();
    const authMedha = new Medha({
      store,
      permissions: { allowedAuthors: ['agent:trusted', 'admin'] },
    });
    expect(() =>
      authMedha.record(KEY, 'APPLY', { now: NOW }, { ensure: true, author: 'agent:rogue' }),
    ).toThrow();

    const ok = await authMedha.record(
      KEY,
      'APPLY',
      { now: NOW },
      { ensure: true, author: 'agent:trusted' },
    );
    expect(ok.state).toBeDefined();
  });
});

describe('write plane — retract and removeEpisode (§6.2)', () => {
  test('retract masks bad episode and updates entity projection', async () => {
    const { store, medha } = makeEngine();
    // Trial 1: success
    await medha.record(KEY, 'APPLY', { now: NOW }, { ensure: true, author: 'agent:1' });
    // Trial 2: spurious success recorded in error
    await medha.record(KEY, 'APPLY', { now: NOW + 1000 }, { author: 'agent:rogue' });

    let state = await store.get(KEY);
    expect(state?.evidence.k).toBe(2);

    // Retract episode 1
    const ret = await medha.retract(1, 'spurious accept', { now: NOW + 2000 }, { author: 'admin' });
    expect(ret.episode.type).toBe('retract');

    state = await store.get(KEY);
    expect(state?.evidence.k).toBe(1);
    expect(state?.evidence.n).toBe(1);
  });

  test('removeEpisode physically removes bad episode from log and rebuilds', async () => {
    const { store, medha } = makeEngine();
    await medha.record(KEY, 'APPLY', { now: NOW }, { ensure: true, author: 'agent:1' });
    await medha.record(KEY, 'APPLY', { now: NOW + 1000 }, { author: 'agent:rogue' });

    const before = await store.episodes();
    expect(before).toHaveLength(2);

    const res = await medha.removeEpisode(1);
    expect(res.removed).toBe(true);
    expect(res.remainingCount).toBe(1);

    const after = await store.episodes();
    expect(after).toHaveLength(1);
    expect(after[0]?.seq).toBe(0);

    const state = await store.get(KEY);
    expect(state?.evidence.k).toBe(1);
  });

  // GitHub #8: a hard delete used to leave no trace of who removed what, or why.
  test('removeEpisode keeps who, why, when and the removed episode in the audit trail', async () => {
    const { store, medha } = makeEngine();
    await medha.record(KEY, 'APPLY', { now: NOW }, { ensure: true, author: 'agent:1' });
    await medha.record(KEY, 'APPLY', { now: NOW + 1000 }, { author: 'agent:rogue' });
    const [, rogue] = await store.episodes();

    await medha.removeEpisode(1, { author: 'human:ops', reason: 'forged signal', now: NOW + 5 });
    const trail = await medha.removedEpisodes();
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      removedAt: NOW + 5,
      author: 'human:ops',
      reason: 'forged signal',
    });
    expect(trail[0]?.episode).toEqual(rogue as NonNullable<typeof rogue>);

    // A miss removes nothing and records nothing; an empty reason is refused.
    expect((await medha.removeEpisode(99, { author: 'human:ops', reason: 'x' })).removed).toBe(
      false,
    );
    await expect(medha.removeEpisode(0, { reason: '  ' })).rejects.toThrow(/reason/);
    expect(await medha.removedEpisodes()).toHaveLength(1);
  });

  test('removeEpisode is gated on the author like every other write', async () => {
    const { store, medha } = makeEngine();
    await medha.record(KEY, 'APPLY', { now: NOW }, { ensure: true, author: 'agent:1' });
    const gated = new Medha({ store, permissions: { requireAuthor: true } });
    await expect(gated.removeEpisode(0)).rejects.toThrow(/author/i);
    // Before #8 the author was never passed through, so this refused every caller.
    expect((await gated.removeEpisode(0, { author: 'human:ops' })).removed).toBe(true);
  });
});

function entityKey(k: EntityKey): string {
  return `${k.namespace}\u0000${k.kind}\u0000${k.id}`;
}

describe('signal limits (spec §9.1)', () => {
  const NOW = 1_700_000_000_000;
  const key = { namespace: 'ns', kind: 'rule', id: 'limited' };
  const limitedStore = () =>
    new MemoryStore({
      registries: {
        kinds: [],
        signalSpecs: [],
        anchorKinds: [],
        kindSpecs: [{ name: 'rule', signalLimits: { maxSuccessesPerAuthor: 3 } }],
      },
    });

  test('an author flooding successes is capped, told so, and cannot reach trusted', async () => {
    const store = limitedStore();
    const medha = new Medha({ store });
    await medha.reportGuard(key, { ok: true, kind: 'ci' }, { now: NOW });
    const outcomes = [];
    for (let i = 0; i < 40; i++) {
      outcomes.push(
        await medha.record(key, 'APPLY', { now: NOW + i }, { ensure: true, author: 'agent' }),
      );
    }
    expect(outcomes.filter((o) => o.suppressed === false)).toHaveLength(3);
    expect(outcomes.filter((o) => o.suppressed === true)).toHaveLength(37);
    const { hint } = await medha.show(key, { now: NOW + 100 });
    expect(hint.evidence.totalTrials).toBe(3);
    expect(hint.status).not.toBe('trusted');
  });

  test('a rejection is never suppressed, and a kind without limits reports no flag', async () => {
    const store = limitedStore();
    const medha = new Medha({ store });
    await medha.record(key, 'APPLY', { now: NOW }, { ensure: true, author: 'a' });
    const rejected = await medha.record(key, 'REJECT_RULE', { now: NOW + 1 }, { author: 'a' });
    expect(rejected.suppressed).toBeUndefined();
    expect(rejected.hint.evidence.totalTrials).toBe(2);

    const plain = new Medha({
      store: new MemoryStore({ registries: { kinds: [], signalSpecs: [], anchorKinds: [] } }),
    });
    const out = await plain.record(key, 'APPLY', { now: NOW }, { ensure: true, author: 'a' });
    expect(out.suppressed).toBeUndefined();
  });

  test('replaying the log from scratch reproduces the same limited state', async () => {
    const store = limitedStore();
    const medha = new Medha({ store });
    for (let i = 0; i < 8; i++) {
      await medha.record(key, 'APPLY', { now: NOW + i }, { ensure: true, author: 'a' });
    }
    const live = await store.get(key);
    const replayed = foldLog(await store.episodes(), {
      kinds: new KindRegistry([{ name: 'rule', signalLimits: { maxSuccessesPerAuthor: 3 } }]),
    });
    expect(live?.authors?.a).toEqual({ lastAt: NOW + 2, counted: 3, suppressed: 5 });
    expect(replayed[0]?.authors).toEqual(live?.authors);
    expect(replayed[0]?.evidence).toEqual(live?.evidence);
  });

  test('compaction keeps the ledger, so it cannot be used to reset an author cap', async () => {
    const store = limitedStore();
    const medha = new Medha({ store });
    for (let i = 0; i < 6; i++) {
      await medha.record(key, 'APPLY', { now: NOW + i }, { ensure: true, author: 'a' });
    }
    const before = (await store.get(key))?.authors;
    const later = NOW + 400 * 86_400_000;
    await medha.compact({ now: later }, { olderThan: 90 });
    expect((await store.get(key))?.authors).toEqual(before);
    const again = await medha.record(key, 'APPLY', { now: later }, { author: 'a' });
    expect(again.suppressed).toBe(true);
  });
});

describe('compaction respects kind specs', () => {
  const NOW = 1_700_000_000_000;
  const key = { namespace: 'ns', kind: 'rule', id: 'weighted' };

  test('signal-value weighted evidence survives compaction unchanged', async () => {
    const store = new MemoryStore({
      registries: {
        kinds: [],
        signalSpecs: [{ name: 'HALF', value: 0.5, countsAsTrial: true, countsAsSuccess: true }],
        anchorKinds: [],
        kindSpecs: [{ name: 'rule', evidenceWeighting: 'signal-value' }],
      },
    });
    const medha = new Medha({ store });
    for (let i = 0; i < 6; i++) {
      await medha.record(key, 'HALF', { now: NOW + i }, { ensure: true });
    }
    const before = await store.get(key);
    expect(before?.evidence.n).toBe(3);
    await medha.compact({ now: NOW + 400 * 86_400_000 }, { olderThan: 90 });
    const after = await store.get(key);
    expect(after?.evidence).toEqual(before?.evidence);
    expect(after?.status).toBe(before?.status);
  });
});

describe('medha-arj.1/.2/.4: write plane — define and decision', () => {
  test('define appends a define episode and never creates the entity', async () => {
    const { store, medha } = makeEngine();
    const out = await medha.define(
      { ...KEY, kind: HOST_KIND },
      { title: 'r1', rationale: 'a rule worth defining' },
      ctx,
    );
    expect(out.episode.type).toBe('define');
    expect(await store.get({ ...KEY, kind: HOST_KIND })).toBeUndefined();
  });

  test('decision mints a fresh caseId when none is given, and reuses one passed to edit', async () => {
    const { store, medha } = makeEngine();
    const key = { ...KEY, kind: HOST_KIND };
    const created = await medha.decision(
      key,
      { condition: 'x', decision: { type: 'ignore' } },
      ctx,
      { random: () => 0.5 },
    );
    expect(created.caseId).toMatch(/^r1-dec-[0-9a-z]{5}$/);

    const edited = await medha.decision(
      key,
      { condition: 'x', decision: { type: 'apply' }, caseId: created.caseId },
      { now: NOW + 1 },
    );
    expect(edited.caseId).toBe(created.caseId);

    const log = await store.episodes();
    expect(log.filter((e) => e.type === 'decision')).toHaveLength(2);
  });

  test('editing a branch without a parentId keeps it nested; detach promotes it', async () => {
    const { medha } = makeEngine();
    const key = { ...KEY, kind: HOST_KIND };
    const root = await medha.decision(
      key,
      { condition: 'root', decision: { type: 'apply' } },
      ctx,
      { random: () => 0.1 },
    );
    const child = await medha.decision(
      key,
      { condition: 'child', decision: { type: 'ignore' }, parentId: root.caseId },
      { now: NOW + 1 },
      { random: () => 0.2 },
    );
    const find = async (id: string) =>
      (await medha.show(key, { now: NOW + 9 })).decisionTree?.find((k) => k.id === id);

    // An edit that says nothing about position must not move the branch.
    await medha.decision(
      key,
      { condition: 'child', decision: { type: 'probability', value: 0.4 }, caseId: child.caseId },
      { now: NOW + 2 },
    );
    expect((await find(child.caseId))?.parentId).toBe(root.caseId);
    expect((await find(child.caseId))?.decision).toEqual({ type: 'probability', value: 0.4 });

    // detach is the explicit, and only, way to move it to the top level.
    await medha.decision(
      key,
      { condition: 'child', decision: { type: 'ignore' }, caseId: child.caseId, detach: true },
      { now: NOW + 3 },
    );
    expect((await find(child.caseId))?.parentId).toBeUndefined();
  });

  test('decision refuses a structurally broken tree: unknown parent, cycle, duplicate condition', async () => {
    const { medha } = makeEngine();
    const key = { ...KEY, kind: HOST_KIND };
    const rootA = await medha.decision(
      key,
      { condition: 'root A', decision: { type: 'apply' } },
      ctx,
      { random: () => 0.1 },
    );
    const rootB = await medha.decision(
      key,
      { condition: 'root B', decision: { type: 'apply' } },
      { now: NOW + 1 },
      { random: () => 0.2 },
    );

    // An unknown parent is refused instead of quietly creating a root-level orphan.
    await expect(
      medha.decision(
        key,
        { condition: 'orphan', decision: { type: 'apply' }, parentId: 'nope-123' },
        { now: NOW + 2 },
      ),
    ).rejects.toThrow(/decision\.parentId/);

    // A branch cannot be its own parent.
    await expect(
      medha.decision(
        key,
        {
          condition: 'root A',
          decision: { type: 'apply' },
          caseId: rootA.caseId,
          parentId: rootA.caseId,
        },
        { now: NOW + 3 },
      ),
    ).rejects.toThrow(/decision\.parentId/);

    const legacy = await medha.decision(
      key,
      { condition: 'in legacy', decision: { type: 'ignore' }, parentId: rootA.caseId },
      { now: NOW + 4 },
      { random: () => 0.3 },
    );

    // Re-parenting under the branch's own descendant would close a loop.
    const grandchild = await medha.decision(
      key,
      { condition: 'grandchild', decision: { type: 'apply' }, parentId: legacy.caseId },
      { now: NOW + 5 },
      { random: () => 0.4 },
    );
    await expect(
      medha.decision(
        key,
        {
          condition: 'in legacy',
          decision: { type: 'ignore' },
          caseId: legacy.caseId,
          parentId: grandchild.caseId,
        },
        { now: NOW + 6 },
      ),
    ).rejects.toThrow(/decision\.parentId/);

    // The same condition under the same parent is a duplicate, even re-cased and re-spaced.
    await expect(
      medha.decision(
        key,
        { condition: 'IN   Legacy', decision: { type: 'ignore' }, parentId: rootA.caseId },
        { now: NOW + 7 },
      ),
    ).rejects.toThrow(/decision\.condition/);

    // Under a different parent it is a genuinely different branch.
    await expect(
      medha.decision(
        key,
        { condition: 'in legacy', decision: { type: 'ignore' }, parentId: rootB.caseId },
        { now: NOW + 8 },
        { random: () => 0.5 },
      ),
    ).resolves.toBeDefined();
  });

  test('a decision edit with a caseId that names no branch is refused, and the tree does not grow', async () => {
    const { store, medha } = makeEngine();
    const key = { ...KEY, kind: HOST_KIND };
    await medha.decision(key, { condition: 'root', decision: { type: 'apply' } }, ctx, {
      random: () => 0.1,
    });
    const before = (await store.episodes()).length;

    // A mistyped id used to mint a branch literally called `r1-dec-typo`: the intended branch
    // stayed untouched and the tree quietly grew a stray leaf.
    await expect(
      medha.decision(
        key,
        { condition: 'revised', decision: { type: 'ignore' }, caseId: 'r1-dec-typo' },
        ctx,
      ),
    ).rejects.toThrow(/decision\.caseId/);
    expect((await store.episodes()).length).toBe(before);
    expect(foldDecisionTree(await store.episodes(), key).length).toBe(1);
  });

  test('record with a caseId that names no branch is refused, and no episode is written', async () => {
    const { store, medha } = makeEngine();
    const key = { ...KEY, kind: HOST_KIND };
    const created = await medha.decision(
      key,
      { condition: 'root', decision: { type: 'apply' } },
      ctx,
      {
        random: () => 0.1,
      },
    );
    const before = (await store.episodes()).length;

    await expect(
      medha.record(key, 'APPLY', ctx, { ensure: true, caseId: 'r1-dec-typo' }),
    ).rejects.toThrow(/options\.caseId/);
    // The signal must not have landed on the rule as a whole as a silent fallback.
    expect((await store.episodes()).length).toBe(before);

    // The real branch still accepts evidence, and the entity learns too.
    const outcome = await medha.record(
      key,
      'APPLY',
      { now: NOW + 1 },
      {
        ensure: true,
        caseId: created.caseId,
      },
    );
    expect(outcome.hint.evidence.totalTrials).toBe(1);
    const after = (await medha.show(key, { now: NOW + 1 })).decisionTree ?? [];
    expect(after.find((k) => k.id === created.caseId)?.evidence.n).toBe(1);
  });

  test("decisionPolicy.requireHumanFor rejects an agent-authored 'apply' branch and accepts a human one", async () => {
    const store = new MemoryStore({
      registries: {
        kinds: [],
        signalSpecs: [],
        anchorKinds: [],
        kindSpecs: [{ name: HOST_KIND, decisionPolicy: { requireHumanFor: 'apply' } }],
      },
    });
    const medha = new Medha({ store });
    const key = { ...KEY, kind: HOST_KIND };
    await expect(
      medha.decision(key, { condition: 'x', decision: { type: 'apply' } }, ctx, {
        author: 'agent:reviewer',
      }),
    ).rejects.toThrow(PermissionDeniedError);

    const out = await medha.decision(key, { condition: 'x', decision: { type: 'apply' } }, ctx, {
      author: 'human:nimish',
    });
    expect(out.episode.type).toBe('decision');
  });
});
