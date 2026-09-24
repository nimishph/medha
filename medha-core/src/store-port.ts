import type { EntityKey, EntityState } from './entity.ts';
import type { Episode, EpisodeInput } from './episode.ts';
import type { KindSpec } from './kinds.ts';
import type { SignalSpec } from './signals.ts';

/**
 * StorePort, library spec §7.1.
 *
 * One storage contract, several backends (in-memory, file JSON, SQLite). It stores:
 *
 *   - entity state, keyed by `(namespace, kind, id)`;
 *   - the append-only **episode log** (the source of truth — state is a fold over it);
 *   - the registries (kinds, signal specs, anchor kinds).
 *
 * A backend can be rebuilt entirely from the log (`rebuild`), which is what fold-equivalence
 * tests verify. Backends are required to behave identically: the contract suite written here runs
 * against every backend with no per-backend branching.
 *
 * Failure behaviour (§7.1): a corrupt store never crashes the host. `open()` reports corruption
 * up front; reads (`get`, `list`, `rebuild`) then fall back to the last good snapshot and keep
 * working, and only writes (`appendIngest`) refuse until the log is repaired. Nothing is silently
 * reset.
 */

export type StoreRegistries = {
  readonly kinds: readonly string[];
  readonly signalSpecs: readonly SignalSpec[];
  readonly anchorKinds: readonly string[];
  readonly kindSpecs?: readonly KindSpec[];
};

/** Why and where a store's log is unusable past some point. */
export interface CorruptLocation {
  /** Backend-internal identifier, e.g. the file path ('' for in-memory). */
  readonly source: string;
  /** First episode sequence number that could not be read. */
  readonly atSeq: number;
}

export type OpenResult =
  | { readonly status: 'ok' }
  | { readonly status: 'corrupt'; readonly location: CorruptLocation };

export interface AppendResult {
  /** The stored episode, with its store-assigned `seq`. */
  readonly episode: Episode;
  /** The entity state after folding this episode, if it has one ('purge' and unauthorised no-ops are `undefined`). */
  readonly state: EntityState | undefined;
}

export type StorePort = {
  readonly name: string;
  readonly registries: StoreRegistries;
} & Readonly<{
  open(): Promise<OpenResult>;
  isOpen(): boolean;
  close(): Promise<void>;
  /** Append one episode: assigns a monotonic seq, persists it, folds it into state. */
  append(episode: EpisodeInput): Promise<AppendResult>;
  /** Read the log: episodes with seq > afterSeq, in order, at most limit of them. */
  episodes(afterSeq?: number, limit?: number): Promise<Episode[]>;
  get(key: EntityKey): Promise<EntityState | undefined>;
  list(): Promise<EntityState[]>;
  /** Rebuild every entity state by folding the whole log. */
  rebuild(): Promise<EntityState[]>;
  /**
   * Atomically replace the whole log with a validated, contiguous one (compaction, restore).
   * Returns the seq range that was replaced. Fold-equivalent input leaves the projection unchanged.
   */
  replaceLog(episodes: readonly Episode[]): Promise<{ readonly from: number; readonly to: number }>;
  /** Read a backend meta value (e.g. the last-sweep marker); `undefined` when absent. */
  getMeta(key: string): Promise<string | undefined>;
  /** Persist a backend meta value. Keys are opaque; values are strings. */
  setMeta(key: string, value: string): Promise<void>;
}>;
