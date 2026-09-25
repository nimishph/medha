/**
 * Minimal in-memory StorePort for medha-sync unit tests (§7.1, §7.2).
 * Conforms to @cntxt-labs/medha-core StorePort without violating dependency boundaries.
 */

import {
  type AppendResult,
  assignSeq,
  type EntityKey,
  type EntityState,
  type Episode,
  type EpisodeInput,
  entityKeyString,
  foldLog,
  type OpenResult,
  type StorePort,
  type StoreRegistries,
} from '@cntxt-labs/medha-core';

export function createTestStore(registries?: StoreRegistries): StorePort {
  let log: Episode[] = [];
  const meta = new Map<string, string>();
  let open = false;

  const effectiveRegistries: StoreRegistries = registries ?? {
    kinds: ['rule', 'recipe', 'tool'],
    signalSpecs: [
      { name: 'APPLY', value: 1.0, countsAsTrial: true, countsAsSuccess: true },
      { name: 'SKIP', value: 0.0, countsAsTrial: false, countsAsSuccess: false },
      { name: 'REJECT_CONTEXT', value: -0.2, countsAsTrial: false, countsAsSuccess: false },
      { name: 'REJECT_RULE', value: -1.0, countsAsTrial: true, countsAsSuccess: false },
    ],
    anchorKinds: ['git-head'],
  };

  return {
    name: 'test-memory',
    registries: effectiveRegistries,
    async open(): Promise<OpenResult> {
      open = true;
      return { status: 'ok' };
    },
    isOpen(): boolean {
      return open;
    },
    async close(): Promise<void> {
      open = false;
    },
    async append(input: EpisodeInput): Promise<AppendResult> {
      const ep = assignSeq(input, log.length);
      log.push(ep);
      const states = foldLog(log);
      const state = states.find((s) => entityKeyString(s.key) === entityKeyString(input.key));
      return { episode: ep, state };
    },
    async episodes(afterSeq?: number, limit?: number): Promise<Episode[]> {
      const filtered = afterSeq === undefined ? log : log.filter((e) => e.seq > afterSeq);
      return limit !== undefined ? filtered.slice(0, limit) : [...filtered];
    },
    async get(key: EntityKey): Promise<EntityState | undefined> {
      const states = foldLog(log);
      return states.find((s) => entityKeyString(s.key) === entityKeyString(key));
    },
    async list(): Promise<EntityState[]> {
      return foldLog(log);
    },
    async rebuild(): Promise<EntityState[]> {
      return foldLog(log);
    },
    async replaceLog(
      episodes: readonly Episode[],
    ): Promise<{ readonly from: number; readonly to: number }> {
      const from = 0;
      const to = log.length;
      log = [...episodes];
      return { from, to };
    },
    async getMeta(key: string): Promise<string | undefined> {
      return meta.get(key);
    },
    async setMeta(key: string, value: string): Promise<void> {
      meta.set(key, value);
    },
  };
}
