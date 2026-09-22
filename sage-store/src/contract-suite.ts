import { describe, expect, test } from 'bun:test';
import type {
  EntityKey,
  EntityState,
  Episode,
  EpisodeInput,
  SignalSpec,
  StorePort,
} from '@sutras/sage-core';
import {
  APPLY,
  foldLog,
  REJECT_CONTEXT,
  REJECT_RULE,
  SageError,
  UnknownKindError,
} from '@sutras/sage-core';
import { CorruptStoreError, StoreClosedError } from './errors.ts';

/**
 * The one StorePort contract suite (spec §7.1). Every backend (memory, file, SQLite) runs this exact
 * suite with no per-backend branch. The suite owns the shared vocabulary — the same key, the same
 * host-registered kind and signal — so backends are compared on identical episodes, and a backend
 * that passes here is interchangeable with the others.
 */

export interface StoreContractSetup {
  /** Host-registered kind available in every store's registries. */
  readonly extraKind: string;
  /** Host signal registered in every store's registries. */
  readonly hostSignal: SignalSpec;
  /** Create a fresh, healthy store (opened by the suite). */
  create(): Promise<StorePort>;
  /** Create a store with a corrupt log past an otherwise-valid prefix (opened by the suite). */
  createCorrupt(): Promise<StorePort>;
}

export const KEY: EntityKey = { namespace: 'n', kind: 'rule', id: 'r1' };

const NOW = 1_700_000_000_000;

export function applyAt(key: EntityKey, at: number): EpisodeInput {
  return { type: 'signal', key, at, spec: APPLY, ensure: true };
}

export function rejectAt(key: EntityKey, at: number): EpisodeInput {
  return { type: 'signal', key, at, spec: REJECT_RULE, ensure: true };
}

export function contextRejectAt(key: EntityKey, at: number): EpisodeInput {
  return { type: 'signal', key, at, spec: REJECT_CONTEXT, ensure: true };
}

export function guardAt(key: EntityKey, ok: boolean, at: number): EpisodeInput {
  return { type: 'guard', key, at, ok, ensure: true };
}

export function overrideAt(key: EntityKey, at: number): EpisodeInput {
  return { type: 'override', key, at, override: 'retired', reason: 'contract suite' };
}

export function purgeAt(key: EntityKey, at: number): EpisodeInput {
  return { type: 'sweep', key, at, action: 'purge', reason: 'contract suite' };
}

export function runStoreContractSuite(setup: StoreContractSetup): void {
  describe('store contract — §7.1', () => {
    test('open report on a healthy store is ok', async () => {
      const store = await setup.create();
      expect((await store.open()).status).toBe('ok');
      expect(store.isOpen()).toBe(true);
    });

    test('registries carry the built-ins and the host extras', async () => {
      const store = await setup.create();
      await store.open();
      expect(store.registries.kinds).toContain('rule');
      expect(store.registries.kinds).toContain(setup.extraKind);
      expect(store.registries.signalSpecs.map((s) => s.name)).toContain('APPLY');
      expect(store.registries.signalSpecs.map((s) => s.name)).toContain(setup.hostSignal.name);
      expect(store.registries.anchorKinds).toContain('week');
    });

    test('opened store is empty: get is undefined, list is empty, log has nothing', async () => {
      const store = await setup.create();
      await store.open();
      expect(await store.get(KEY)).toBeUndefined();
      expect(await store.list()).toEqual([]);
      expect(await store.episodes()).toEqual([]);
    });

    test('append assigns strictly increasing seqs and returns the folded state', async () => {
      const store = await setup.create();
      await store.open();
      const first = await store.append(applyAt(KEY, NOW));
      const second = await store.append(rejectAt(KEY, NOW + 1));
      expect(first.episode.seq).toBe(0);
      expect(second.episode.seq).toBe(1);
      expect(first.state?.key).toEqual(KEY);
      expect(first.state?.evidence.n).toBe(1);
      expect(second.state?.evidence.n).toBe(2);
      expect(second.state?.evidence.k).toBe(1);
    });

    test('get, list and the log all agree after appends', async () => {
      const store = await setup.create();
      await store.open();
      await store.append(applyAt(KEY, NOW));
      await store.append(rejectAt(KEY, NOW + 1));
      await store.append(guardAt(KEY, true, NOW + 2));

      const state = await store.get(KEY);
      expect(state).toBeDefined();
      const listed = await store.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toEqual(state);

      const log = await store.episodes();
      expect(log).toHaveLength(3);
      expect(log.map((e) => e.seq)).toEqual([0, 1, 2]);
      for (const episode of log) expect(episode.at).toBeGreaterThanOrEqual(NOW);
    });

    test('episodes after/limit slice the log, validation of limit stays typed', async () => {
      const store = await setup.create();
      await store.open();
      for (let i = 0; i < 5; i++) await store.append(applyAt(KEY, NOW + i));
      expect((await store.episodes(1)).map((e) => e.seq)).toEqual([2, 3, 4]);
      expect((await store.episodes(undefined, 2)).map((e) => e.seq)).toEqual([0, 1]);
      expect((await store.episodes(1, 2)).map((e) => e.seq)).toEqual([2, 3]);
      await expect(store.episodes(undefined, 0)).rejects.toThrow();
    });

    test('an episode that does not ensure an unknown entity records no state (spec §5.2)', async () => {
      const store = await setup.create();
      await store.open();
      const { episode, state } = await store.append({
        type: 'signal',
        key: KEY,
        at: NOW,
        spec: APPLY,
        ensure: false,
      });
      expect(episode.seq).toBe(0);
      expect(state).toBeUndefined();
      expect(await store.get(KEY)).toBeUndefined();
    });

    test('an override or purge on an unknown entity is a logged no-op, not an error', async () => {
      const store = await setup.create();
      await store.open();
      await store.append(overrideAt(KEY, NOW));
      await store.append(purgeAt(KEY, NOW + 1));
      expect(await store.get(KEY)).toBeUndefined();
      expect(await store.episodes()).toHaveLength(2);
    });

    test('a sweep purge removes the entity but keeps the log (§8)', async () => {
      const store = await setup.create();
      await store.open();
      await store.append(applyAt(KEY, NOW));
      await store.append(purgeAt(KEY, NOW + 1));
      expect(await store.get(KEY)).toBeUndefined();
      expect(await store.list()).toEqual([]);
      expect((await store.episodes()).map((e) => e.seq)).toEqual([0, 1]);
    });

    test('unknown kinds fail loud with the registry names', async () => {
      const store = await setup.create();
      await store.open();
      await expect(
        store.append({
          type: 'signal',
          key: { namespace: 'n', kind: 'mystery', id: 'x' },
          at: NOW,
          spec: APPLY,
          ensure: true,
        }),
      ).rejects.toThrow(UnknownKindError);
    });

    test('rebuild equals the stored projection — fold-equivalence, byte-for-byte', async () => {
      const store = await setup.create();
      await store.open();
      const other = { namespace: 'n', kind: setup.extraKind, id: 'extra' } satisfies EntityKey;
      await store.append(applyAt(KEY, NOW));
      await store.append(contextRejectAt(KEY, NOW + 1));
      await store.append(guardAt(KEY, false, NOW + 2));
      await store.append(overrideAt(KEY, NOW + 3));
      await store.append(applyAt(other, NOW + 4));
      await store.append(purgeAt(other, NOW + 5));

      const listed = await store.list();
      const rebuilt = await store.rebuild();
      expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(listed));
      expect(rebuilt).toHaveLength(1);
      expect(rebuilt[0]?.key).toEqual(KEY);
      expect(rebuilt[0]?.status).toBe('retired');
    });

    test('a closed store refuses every operation with the typed error', async () => {
      const store = await setup.create();
      expect(store.isOpen()).toBe(false);
      await expect(store.get(KEY)).rejects.toThrow(StoreClosedError);
      await expect(store.list()).rejects.toThrow(StoreClosedError);
      await expect(store.episodes()).rejects.toThrow(StoreClosedError);
      await expect(store.rebuild()).rejects.toThrow(StoreClosedError);
      await expect(store.append(applyAt(KEY, NOW))).rejects.toThrow(StoreClosedError);
      await expect(store.getMeta('sweep:lastRun')).rejects.toThrow(StoreClosedError);
      await expect(store.setMeta('sweep:lastRun', '1')).rejects.toThrow(StoreClosedError);
      await expect(store.replaceLog([])).rejects.toThrow(StoreClosedError);
    });

    test('close ends the session: everything refuses again and reopen sees the fold', async () => {
      const store = await setup.create();
      await store.open();
      await store.append(applyAt(KEY, NOW));
      await store.close();
      await expect(store.append(applyAt(KEY, NOW + 1))).rejects.toThrow(StoreClosedError);
      const reopened = await store.open();
      expect(reopened.status).toBe('ok');
      expect(await store.get(KEY)).toBeDefined();
    });
  });

  describe('store contract — corrupt log (§7.1)', () => {
    test('open reports corruption with a typed location, never a crash', async () => {
      const store = await setup.createCorrupt();
      const result = await store.open();
      expect(result.status).toBe('corrupt');
      if (result.status === 'corrupt') {
        expect(result.location.atSeq).toBeGreaterThanOrEqual(0);
        expect(typeof result.location.source).toBe('string');
      }
      expect(store.isOpen()).toBe(true);
    });

    test('reads fall back to the last good snapshot (the valid prefix)', async () => {
      const store = await setup.createCorrupt();
      await store.open();
      const snapshot = await store.list();
      const log = await store.episodes();
      const rebuilt = await store.rebuild();
      expect(rebuildablePrefix(log)).toBe(true);
      expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(snapshot));
      expect(snapshot.length).toBeGreaterThan(0);
    });

    test('writes refuse with the typed CorruptStoreError — nothing is silently reset', async () => {
      const store = await setup.createCorrupt();
      await store.open();
      const before = await store.episodes();
      let failure: unknown;
      try {
        await store.append(applyAt(KEY, NOW));
      } catch (thrown) {
        failure = thrown;
      }
      expect(SageError.is(failure)).toBe(true);
      expect(failure instanceof CorruptStoreError).toBe(true);
      const err = failure as CorruptStoreError;
      expect(err.location.atSeq).toBeGreaterThanOrEqual(0);
      expect(err.subsystem).toBe('store');
      expect(err.code).toBe('STORE_LOG_CORRUPT');
      // Refusal is non-mutating: the log is exactly what it was before the attempt.
      expect(await store.episodes()).toEqual(before);
    });

    test('the log keeps the full healthy prefix after corruption is reported', async () => {
      const store = await setup.createCorrupt();
      await store.open();
      const log = await store.episodes();
      const atSeqs = log.map((e) => e.seq);
      expect(atSeqs).toEqual([...atSeqs].sort((a, b) => a - b));
      const result = await store.open();
      if (result.status === 'corrupt') {
        expect(Math.max(...atSeqs)).toBeLessThan(result.location.atSeq);
      }
    });
  });

  describe('store contract — replaceLog & meta (§8.4)', () => {
    test('meta round-trips and persists across reopen; missing keys read undefined', async () => {
      const store = await setup.create();
      await store.open();
      expect(await store.getMeta('sweep:lastRun')).toBeUndefined();
      await store.setMeta('sweep:lastRun', '123');
      expect(await store.getMeta('sweep:lastRun')).toBe('123');
      await store.close();
      const reopened = await store.open();
      expect(reopened.status).toBe('ok');
      expect(await store.getMeta('sweep:lastRun')).toBe('123');
    });

    test('replaceLog is atomic and idempotent for an unchanged log', async () => {
      const store = await setup.create();
      await store.open();
      await store.append(applyAt(KEY, NOW));
      await store.append(rejectAt(KEY, NOW + 1));
      const before = await store.list();
      const log = await store.episodes();
      const result = await store.replaceLog(log);
      expect(result.from).toBe(0);
      expect(result.to).toBe(1);
      expect(await store.list()).toEqual(before);
      expect(await store.episodes()).toEqual(log);
    });

    test('a fold-equivalent compacted log replaces the log without moving the projection', async () => {
      const store = await setup.create();
      await store.open();
      await store.append(applyAt(KEY, NOW));
      await store.append(applyAt(KEY, NOW + 1));
      await store.append(rejectAt(KEY, NOW + 2));
      await store.append(applyAt(KEY, NOW + 3));
      const before = await store.rebuild();
      const log = await store.episodes();

      // Compact everything but the last apply into one baseline; the suffix keeps the newest signal.
      const prefix = log.slice(0, log.length - 1);
      const baseline = foldLog(prefix)[0];
      const compacted = compactIntoBaseline(KEY, prefix, baseline, log.slice(log.length - 1));
      expect(baseline).toBeDefined();
      expect(compacted.length).toBe(2);

      await store.replaceLog(compacted);
      const after = await store.rebuild();
      expect(JSON.stringify(after)).toBe(JSON.stringify(before));
      expect(await store.list()).toEqual(after);
      expect(await store.episodes()).toHaveLength(compacted.length);
      const last = await store.episodes();
      expect(last[last.length - 1]).toMatchObject({ type: 'signal' });
    });

    test('replaceLog refuses a non-contiguous log and leaves the store unchanged', async () => {
      const store = await setup.create();
      await store.open();
      await store.append(applyAt(KEY, NOW));
      await store.append(rejectAt(KEY, NOW + 1));
      const before = await store.episodes();
      const bad = (await store.episodes()).map((e) =>
        e.seq === 1 ? { ...e, seq: 5 } : e,
      ) as Episode[];
      let failure: unknown;
      try {
        await store.replaceLog(bad);
      } catch (thrown) {
        failure = thrown;
      }
      expect(SageError.is(failure)).toBe(true);
      expect(await store.episodes()).toEqual(before);
    });

    test('replaceLog refuses on a corrupt store, like every other write', async () => {
      const store = await setup.createCorrupt();
      await store.open();
      await expect(store.replaceLog([])).rejects.toThrow(CorruptStoreError);
    });
  });
}

/** Turn a compacted prefix + retained suffix into a contiguous, validated log starting at seq 0.
 *  A prefix that folds to `undefined` (purged) is dropped; fold-equivalence still holds. */
function compactIntoBaseline(
  key: EntityKey,
  prefix: readonly Episode[],
  foldedState: EntityState | undefined,
  suffix: readonly Episode[],
): Episode[] {
  const baseline: Episode[] =
    foldedState === undefined
      ? []
      : [
          {
            type: 'baseline',
            seq: 0,
            key,
            at: prefix[prefix.length - 1]?.at ?? 0,
            state: foldedState,
          },
        ];
  return [...baseline, ...suffix.map((episode, i) => ({ ...episode, seq: i + baseline.length }))];
}

const rebuildablePrefix: (log: readonly Episode[]) => boolean = (log) => {
  for (let i = 0; i < log.length - 1; i++) {
    if ((log[i]?.seq ?? 0) >= (log[i + 1]?.seq ?? 0)) return false;
  }
  return true;
};
