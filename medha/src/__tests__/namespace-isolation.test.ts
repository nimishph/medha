import { describe, expect, test } from 'bun:test';
import { type EntityKey, entityKeyString } from '@cntxt-labs/medha-core';
import { MemoryStore, NamespaceViolationError, scopeStore } from '@cntxt-labs/medha-store';
import { Medha } from '../engine.ts';

/**
 * Namespace isolation at the store boundary. Two projects share one store; an engine built over a
 * store scoped to project A must be unable to see, read, influence, or destroy project B — through
 * every engine path, not just the ones a caller is expected to use.
 */

const NOW = 1_700_000_000_000;
const A = 'proj-a';
const B = 'proj-b';
const key = (namespace: string, id: string): EntityKey => ({ namespace, kind: 'rule', id });
const ctx = (offset = 0) => ({ now: NOW + offset });

async function shared() {
  const raw = new MemoryStore({
    registries: { kinds: [], signalSpecs: [], anchorKinds: [] },
  });
  const admin = new Medha({ store: raw });
  for (const ns of [A, B]) {
    await admin.reportGuard(key(ns, 'r1'), { ok: true, kind: 'ci' }, ctx());
    for (let i = 0; i < 6; i++) {
      await admin.record(key(ns, 'r1'), 'APPLY', ctx(i + 1), { ensure: true });
    }
  }
  const scoped = new Medha({ store: scopeStore(raw, [A]) });
  return { raw, admin, scoped };
}

const violation = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(NamespaceViolationError);
};

describe('scoped store — enumeration is filtered', () => {
  test('list, drift and episodes show only the granted namespace', async () => {
    const { scoped } = await shared();
    const listed = (await scoped.list({}, ctx(100))).items;
    expect(listed.map((h) => h.key.namespace)).toEqual([A]);
    const drift = await scoped.drift(ctx(100));
    expect(drift.drifting.every((d) => d.key.namespace === A)).toBe(true);
  });

  test('a namespace filter for a foreign project returns nothing rather than its entities', async () => {
    const { scoped } = await shared();
    expect((await scoped.list({ namespace: B }, ctx(100))).items).toEqual([]);
  });

  test('backup contains only in-scope episodes', async () => {
    const { scoped } = await shared();
    const { snapshot } = await scoped.backup(ctx(100));
    expect(snapshot.episodes.every((e) => e.key.namespace === A)).toBe(true);
    expect(snapshot.episodes.length).toBeGreaterThan(0);
  });
});

describe('scoped store — keyed access outside the scope is refused', () => {
  test('reads: show and simulate refuse a foreign key', async () => {
    const { scoped } = await shared();
    await violation(scoped.show(key(B, 'r1'), ctx(100)));
    await violation(scoped.simulate(key(B, 'r1'), 'APPLY', ctx(100)));
  });

  test('batch reads (hints, explore) omit foreign keys, indistinguishable from unknown ids', async () => {
    const { scoped } = await shared();
    const hints = await scoped.hints([key(A, 'r1'), key(B, 'r1'), key(B, 'nope')], ctx(100));
    expect([...hints.keys()]).toEqual([entityKeyString(key(A, 'r1'))]);
    expect(await scoped.explore([key(B, 'r1')], { slots: 1, seed: 1 }, ctx(100))).toEqual([]);
  });

  test('writes: record (even with ensure), reportGuard, propose, override', async () => {
    const { scoped } = await shared();
    await violation(scoped.record(key(B, 'r1'), 'APPLY', ctx(100), { ensure: true }));
    await violation(scoped.record(key(B, 'new'), 'APPLY', ctx(100), { ensure: true }));
    await violation(scoped.reportGuard(key(B, 'r1'), { ok: false }, ctx(100)));
    await violation(
      scoped.propose({ key: key(B, 'p1'), provenance: 'miner', description: 'x' }, ctx(100)),
    );
    await violation(scoped.override(key(B, 'r1'), 'retire', ctx(100), 'attack'));
  });

  test('a failed cross-namespace attempt changes nothing in the other project', async () => {
    const { raw, scoped } = await shared();
    const before = JSON.stringify(await raw.list());
    const logBefore = (await raw.episodes()).length;
    await violation(scoped.record(key(B, 'r1'), 'REJECT_RULE', ctx(100)));
    await violation(scoped.reportGuard(key(B, 'r1'), { ok: false }, ctx(101)));
    expect(JSON.stringify(await raw.list())).toBe(before);
    expect((await raw.episodes()).length).toBe(logBefore);
  });

  test('retract cannot reach a foreign episode by sequence number', async () => {
    const { raw, scoped } = await shared();
    const foreign = (await raw.episodes()).find((e) => e.key.namespace === B);
    expect(foreign).toBeDefined();
    await expect(
      scoped.retract((foreign?.seq as number) ?? 0, 'attack', ctx(100)),
    ).rejects.toThrow();
    expect((await raw.episodes()).some((e) => e.type === 'retract')).toBe(false);
  });
});

describe('scoped store — whole-log operations are refused', () => {
  test('compact, restore and removeEpisode cannot rewrite the shared log', async () => {
    const { raw, scoped } = await shared();
    const before = JSON.stringify(await raw.episodes());
    await violation(scoped.compact(ctx(500 * 86_400_000), { olderThan: 1 }));
    const { snapshot } = await scoped.backup(ctx(100));
    await violation(scoped.restore(snapshot));
    await violation(scoped.removeEpisode(0));
    expect(JSON.stringify(await raw.episodes())).toBe(before);
    // B's data is intact after all of it.
    expect((await raw.get(key(B, 'r1')))?.evidence.n).toBe(6);
  });

  test('the session sweep still opens on a scoped store and skips compaction', async () => {
    const { scoped } = await shared();
    const opened = await scoped.open(ctx(500 * 86_400_000));
    expect(opened).toBeDefined();
  });
});

describe('scoped store — meta keys are isolated', () => {
  test('two scopes cannot read or overwrite each other’s markers', async () => {
    const { raw } = await shared();
    const a = scopeStore(raw, [A]);
    const b = scopeStore(raw, [B]);
    await a.setMeta('sweep:lastRun', '111');
    expect(await b.getMeta('sweep:lastRun')).toBeUndefined();
    await b.setMeta('sweep:lastRun', '222');
    expect(await a.getMeta('sweep:lastRun')).toBe('111');
    expect(await raw.getMeta('sweep:lastRun')).toBeUndefined();
  });
});

describe('scoped store — construction and multi-namespace grants', () => {
  test('rejects an empty grant', () => {
    const raw = new MemoryStore({ registries: { kinds: [], signalSpecs: [], anchorKinds: [] } });
    expect(() => scopeStore(raw, [])).toThrow();
  });

  test('a two-namespace grant sees both and nothing else', async () => {
    const { raw } = await shared();
    await new Medha({ store: raw }).record(key('proj-c', 'r1'), 'APPLY', ctx(50), {
      ensure: true,
    });
    const both = new Medha({ store: scopeStore(raw, [A, B]) });
    const seen = (await both.list({}, ctx(100))).items.map((h) => entityKeyString(h.key));
    expect(seen.some((k) => k.includes('proj-c'))).toBe(false);
    expect(new Set((await both.list({}, ctx(100))).items.map((h) => h.key.namespace))).toEqual(
      new Set([A, B]),
    );
  });

  test('the default (empty-string) namespace is a namespace like any other', async () => {
    const { raw } = await shared();
    await new Medha({ store: raw }).record(key('', 'root'), 'APPLY', ctx(50), { ensure: true });
    const scoped = new Medha({ store: scopeStore(raw, [A]) });
    await violation(scoped.show(key('', 'root'), ctx(100)));
  });
});
