import { describe, expect, test } from 'bun:test';
import type { EntityKey, StorePort } from '@cntxt-labs/medha-core';
import { applyAt, guardAt, retractAt, type StoreContractSetup } from './contract-suite.ts';
import { NamespaceViolationError } from './errors.ts';
import { scopeStore } from './scoped-store.ts';

/**
 * The shared `scopeStore` contract: one suite, run against every backend (memory, file, SQLite),
 * so namespace isolation behaves identically regardless of what it wraps. This is deliberately a
 * separate suite from `runStoreContractSuite` — `scopeStore` narrows the `StorePort` contract on
 * purpose (keyed access outside the scope throws rather than reading as unknown, `replaceLog` is
 * always refused), so it does not pass the full backend suite and should not attempt to.
 */

const A = 'scope-a';
const B = 'scope-b';

export function runScopeStoreContractSuite(setup: StoreContractSetup): void {
  describe('scopeStore contract', () => {
    async function seeded(): Promise<StorePort> {
      const raw = await setup.create();
      await raw.open();
      const kind = setup.extraKind;
      await raw.append(applyAt({ namespace: A, kind, id: 'r1' }, 1_700_000_000_000));
      await raw.append(guardAt({ namespace: A, kind, id: 'r1' }, true, 1_700_000_000_100));
      await raw.append(applyAt({ namespace: B, kind, id: 'r1' }, 1_700_000_000_000));
      return raw;
    }

    test('rejects an empty or non-string namespace list', async () => {
      const raw = await seeded();
      expect(() => scopeStore(raw, [])).toThrow();
      // @ts-expect-error deliberately wrong element type
      expect(() => scopeStore(raw, [1])).toThrow();
    });

    test('registries and open/close/isOpen delegate to the inner store', async () => {
      const raw = await seeded();
      const scoped = scopeStore(raw, [A]);
      expect(scoped.registries).toEqual(raw.registries);
      expect(scoped.scope).toEqual([A]);
      expect(scoped.isOpen()).toBe(raw.isOpen());
      await scoped.close();
      expect(raw.isOpen()).toBe(false);
    });

    test('get: in-scope resolves, out-of-scope throws (never "unknown")', async () => {
      const raw = await seeded();
      const scoped = scopeStore(raw, [A]);
      const key: EntityKey = { namespace: A, kind: setup.extraKind, id: 'r1' };
      expect((await scoped.get(key))?.key).toEqual(key);
      await expect(
        scoped.get({ namespace: B, kind: setup.extraKind, id: 'r1' }),
      ).rejects.toBeInstanceOf(NamespaceViolationError);
      await expect(
        scoped.get({ namespace: 'never-seen', kind: setup.extraKind, id: 'x' }),
      ).rejects.toBeInstanceOf(NamespaceViolationError);
    });

    test('append: in-scope writes, out-of-scope throws and writes nothing', async () => {
      const raw = await seeded();
      const scoped = scopeStore(raw, [A]);
      const before = (await raw.episodes()).length;
      await scoped.append(applyAt({ namespace: A, kind: setup.extraKind, id: 'r2' }, 1));
      expect((await raw.episodes()).length).toBe(before + 1);

      await expect(
        scoped.append(applyAt({ namespace: B, kind: setup.extraKind, id: 'r2' }, 1)),
      ).rejects.toBeInstanceOf(NamespaceViolationError);
      expect((await raw.episodes()).length).toBe(before + 1);
    });

    test('a baseline episode is checked by the state it carries, not only the outer key', async () => {
      const raw = await seeded();
      const scoped = scopeStore(raw, [A]);
      const foreignState = (await raw.get({
        namespace: B,
        kind: setup.extraKind,
        id: 'r1',
      })) as NonNullable<Awaited<ReturnType<StorePort['get']>>>;
      await expect(
        scoped.append({
          type: 'baseline',
          key: foreignState.key,
          at: foreignState.createdAt,
          state: foreignState,
        }),
      ).rejects.toBeInstanceOf(NamespaceViolationError);
    });

    test('a retraction is checked by the episode it masks, not only the outer key (medha-bis)', async () => {
      const raw = await seeded();
      const scoped = scopeStore(raw, [A]);
      // `seeded()` appends A/A/B, so seq 2 is namespace B's episode.
      const foreignSeq = (await raw.episodes()).find((e) => e.key.namespace === B)?.seq;
      expect(foreignSeq).toBe(2);
      const before = await raw.episodes();

      // The wrapper's own key is in scope, so only the target's namespace can catch this.
      await expect(
        scoped.append(
          retractAt({ namespace: A, kind: setup.extraKind, id: 'r1' }, foreignSeq as number, 1_000),
        ),
      ).rejects.toBeInstanceOf(NamespaceViolationError);
      expect(await raw.episodes()).toEqual(before);

      // ...and namespace B's episode is still foldable: it was not masked out.
      const foreignState = await raw.get({ namespace: B, kind: setup.extraKind, id: 'r1' });
      expect(foreignState?.evidence.n).toBe(1);
    });

    test('a retraction against an in-scope target is allowed', async () => {
      const raw = await seeded();
      const scoped = scopeStore(raw, [A]);
      const inScopeSeq = (await raw.episodes()).find((e) => e.key.namespace === A)?.seq;
      const before = await raw.episodes();

      const { episode } = await scoped.append(
        retractAt({ namespace: A, kind: setup.extraKind, id: 'r1' }, inScopeSeq as number, 1_000),
      );
      expect(episode.type).toBe('retract');
      expect((await raw.episodes()).length).toBe(before.length + 1);
      // The retraction is invisible in the scoped view too — it carries an in-scope key.
      expect((await scoped.episodes()).filter((e) => e.type === 'retract')).toHaveLength(1);
    });

    test("a retraction naming no existing episode is the inner store's call, not a namespace one", async () => {
      const raw = await seeded();
      const scoped = scopeStore(raw, [A]);
      const before = await raw.episodes();
      // The wrapper has no namespace judgment to make here — the target names no namespace. The
      // inner store still refuses it, because an armed pointer into a growing log is not inert.
      await expect(
        scoped.append(retractAt({ namespace: A, kind: setup.extraKind, id: 'r1' }, 9_999, 1_000)),
      ).rejects.toThrow();
      expect(await raw.episodes()).toEqual(before);
    });

    test('list, rebuild and episodes are filtered to the scope', async () => {
      const raw = await seeded();
      const scoped = scopeStore(raw, [A]);
      expect((await scoped.list()).every((s) => s.key.namespace === A)).toBe(true);
      expect((await scoped.list()).length).toBeGreaterThan(0);
      expect((await scoped.rebuild()).every((s) => s.key.namespace === A)).toBe(true);
      expect((await scoped.episodes()).every((e) => e.key.namespace === A)).toBe(true);
      // The unfiltered raw store still has both namespaces.
      expect(new Set((await raw.list()).map((s) => s.key.namespace))).toEqual(new Set([A, B]));
    });

    test('episodes(afterSeq, limit) applies limit after filtering, not before', async () => {
      const raw = await seeded();
      const scoped = scopeStore(raw, [A]);
      for (let i = 0; i < 5; i++) {
        await raw.append(applyAt({ namespace: A, kind: setup.extraKind, id: `bulk${i}` }, i));
      }
      const limited = await scoped.episodes(undefined, 3);
      expect(limited).toHaveLength(3);
      expect(limited.every((e) => e.key.namespace === A)).toBe(true);
    });

    test('a two-namespace grant sees the union and nothing outside it', async () => {
      const raw = await seeded();
      const scoped = scopeStore(raw, [A, B]);
      expect(new Set((await scoped.list()).map((s) => s.key.namespace))).toEqual(new Set([A, B]));
    });

    test('replaceLog is always refused, regardless of the payload', async () => {
      const raw = await seeded();
      const scoped = scopeStore(raw, [A]);
      const before = await raw.episodes();
      await expect(scoped.replaceLog([])).rejects.toBeInstanceOf(NamespaceViolationError);
      await expect(scoped.replaceLog(before)).rejects.toBeInstanceOf(NamespaceViolationError);
      expect(await raw.episodes()).toEqual(before);
    });

    test('meta keys are prefixed per scope and isolated from other scopes and the raw store', async () => {
      const raw = await seeded();
      const a = scopeStore(raw, [A]);
      const b = scopeStore(raw, [B]);
      await a.setMeta('marker', 'from-a');
      expect(await b.getMeta('marker')).toBeUndefined();
      expect(await raw.getMeta('marker')).toBeUndefined();
      await b.setMeta('marker', 'from-b');
      expect(await a.getMeta('marker')).toBe('from-a');
    });
  });
}
