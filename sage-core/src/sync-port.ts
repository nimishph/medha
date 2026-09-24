/**
 * SyncPort and MemorySnapshot contracts, library spec §7.2.
 *
 * Distributed sync across machines and storage tiers over versioned snapshots (schemaVersion: 1).
 * Supports git-ref (refs/sutra/medha/memory), file, and no-op adapters.
 */

import type { Context } from './context.ts';
import type { EntityState } from './entity.ts';
import type { Episode } from './episode.ts';
import { InvalidArgumentError, SchemaVersionError } from './errors.ts';
import type { StoreRegistries } from './store-port.ts';

export type SyncState = 'synced' | 'ahead' | 'behind' | 'diverged' | 'uninitialized';

export interface SyncStatus {
  readonly state: SyncState;
  readonly localCount: number;
  readonly remoteCount?: number | undefined;
  readonly localHead?: string | undefined;
  readonly remoteHead?: string | undefined;
  readonly ref?: string | undefined;
  readonly remoteUrl?: string | undefined;
  readonly message?: string | undefined;
}

export interface PullResult {
  readonly ok: boolean;
  readonly updated: boolean;
  readonly pulledCount: number;
  readonly localTotal: number;
  readonly error?: string | undefined;
}

export interface PushResult {
  readonly ok: boolean;
  readonly pushedCount: number;
  readonly commit?: string | undefined;
  readonly error?: string | undefined;
}

export interface ReconcileResult {
  readonly ok: boolean;
  readonly pulledCount: number;
  readonly pushedCount: number;
  readonly totalCount: number;
  readonly commit?: string | undefined;
  readonly error?: string | undefined;
}

export interface SyncPort {
  readonly name: string;
  status(context?: Context): Promise<SyncStatus>;
  pull(context?: Context): Promise<PullResult>;
  push(context?: Context): Promise<PushResult>;
  reconcile(context?: Context): Promise<ReconcileResult>;
}

/**
 * Memory Snapshot Version 1 — calibrated evidential-memory snapshot.
 *
 * Designed for lightweight, cross-device sync (tens of KB, avoiding git repo bloat).
 * Stores calibrated entity belief states, effective registries, metadata, and optional
 * compacted baseline/episodes.
 */
export const CURRENT_MEMORY_SCHEMA_VERSION = 1;

export interface MemorySnapshotV1 {
  readonly schemaVersion: 1;
  readonly asOf: number;
  readonly registries?: StoreRegistries | undefined;
  readonly entities: readonly EntityState[];
  readonly episodes?: readonly Episode[] | undefined;
  readonly meta?: Readonly<Record<string, string>> | undefined;
}

export type MemorySnapshot = MemorySnapshotV1;

/**
 * Validates or migrates an unknown memory snapshot into MemorySnapshotV1.
 *
 * Future schema upgrades (e.g. V1 -> V2) branch here to upgrade older versions.
 */
export function migrateSnapshot(raw: unknown): MemorySnapshotV1 {
  if (typeof raw !== 'object' || raw === null) {
    throw new InvalidArgumentError('snapshot', 'an object', raw);
  }
  const obj = raw as Record<string, unknown>;

  // Check explicit schemaVersion
  const version = obj.schemaVersion ?? obj.layoutVersion ?? obj.version;
  if (version !== undefined && version !== CURRENT_MEMORY_SCHEMA_VERSION) {
    if (typeof version === 'number' && version > CURRENT_MEMORY_SCHEMA_VERSION) {
      throw new SchemaVersionError(CURRENT_MEMORY_SCHEMA_VERSION, version, {
        hint: 'This snapshot was created by a newer version of @cntxt-labs/medha. Please upgrade your package.',
      });
    }
  }

  // Extract or synthesize entities array
  let entities: EntityState[] = [];
  if (Array.isArray(obj.entities)) {
    entities = obj.entities as EntityState[];
  } else if (typeof obj.rules === 'object' && obj.rules !== null) {
    entities = Object.values(obj.rules) as EntityState[];
  }

  const asOf =
    typeof obj.asOf === 'number'
      ? obj.asOf
      : typeof obj.last_state_update === 'number'
        ? obj.last_state_update
        : Date.now();
  const registries = obj.registries as StoreRegistries | undefined;
  const episodes = Array.isArray(obj.episodes) ? (obj.episodes as Episode[]) : undefined;
  const meta =
    typeof obj.meta === 'object' && obj.meta !== null
      ? (obj.meta as Record<string, string>)
      : undefined;

  return {
    schemaVersion: 1,
    asOf,
    registries,
    entities,
    episodes,
    meta,
  };
}

/**
 * Serializes a snapshot into a deterministic JSON string with 2-space indentation.
 */
export function serializeSnapshot(snapshot: MemorySnapshotV1): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}
