/**
 * FileSyncAdapter — SyncPort over versioned snapshot files, spec §7.2.
 *
 * Persists and reconciles versioned snapshots (schemaVersion: 1) with atomic file writes.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  type Context,
  CURRENT_MEMORY_SCHEMA_VERSION,
  type MemorySnapshotV1,
  migrateSnapshot,
  type PullResult,
  type PushResult,
  type ReconcileResult,
  type StorePort,
  type SyncPort,
  type SyncStatus,
  serializeSnapshot,
} from '@cntxt-labs/medha-core';
import { mergeEntityStates, mergeEpisodes } from './merge.ts';

export interface FileSyncOptions {
  readonly store: StorePort;
  readonly filePath: string;
}

export class FileSyncAdapter implements SyncPort {
  readonly name = 'file';
  readonly store: StorePort;
  readonly filePath: string;

  constructor(options: FileSyncOptions) {
    this.store = options.store;
    this.filePath = resolve(options.filePath);
  }

  async status(_context?: Context): Promise<SyncStatus> {
    const localStates = await this.store.list();
    const localCount = localStates.length;

    if (!existsSync(this.filePath)) {
      return {
        state: 'uninitialized',
        localCount,
        ref: this.filePath,
        message: `Sync file does not exist: ${this.filePath}`,
      };
    }

    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8'));
      const snapshot = migrateSnapshot(raw);
      const remoteCount = snapshot.entities.length;

      if (localCount === remoteCount) {
        return {
          state: 'synced',
          localCount,
          remoteCount,
          ref: this.filePath,
        };
      }
      return {
        state: localCount > remoteCount ? 'ahead' : 'behind',
        localCount,
        remoteCount,
        ref: this.filePath,
      };
    } catch (err) {
      return {
        state: 'diverged',
        localCount,
        ref: this.filePath,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async pull(_context?: Context): Promise<PullResult> {
    const localStates = await this.store.list();
    if (!existsSync(this.filePath)) {
      return {
        ok: true,
        updated: false,
        pulledCount: 0,
        localTotal: localStates.length,
      };
    }

    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8'));
      const snapshot = migrateSnapshot(raw);
      const localEpisodes = await this.store.episodes();

      // If remote has raw episodes, merge them
      if (snapshot.episodes && snapshot.episodes.length > 0) {
        const mergedEpisodes = mergeEpisodes(localEpisodes, snapshot.episodes);
        if (mergedEpisodes.length !== localEpisodes.length) {
          await this.store.replaceLog(mergedEpisodes);
          await this.store.rebuild();
          const updatedStates = await this.store.list();
          return {
            ok: true,
            updated: true,
            pulledCount: snapshot.episodes.length,
            localTotal: updatedStates.length,
          };
        }
      }

      // Merge entity states
      const mergedStates = mergeEntityStates(localStates, snapshot.entities);
      const updated = mergedStates.length !== localStates.length;

      return {
        ok: true,
        updated,
        pulledCount: snapshot.entities.length,
        localTotal: mergedStates.length,
      };
    } catch (err) {
      return {
        ok: false,
        updated: false,
        pulledCount: 0,
        localTotal: localStates.length,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async push(context?: Context): Promise<PushResult> {
    try {
      const entities = await this.store.list();
      const episodes = await this.store.episodes();
      const asOf = context?.now ?? Date.now();

      const snapshot: MemorySnapshotV1 = {
        schemaVersion: CURRENT_MEMORY_SCHEMA_VERSION,
        asOf,
        registries: this.store.registries,
        entities,
        episodes: episodes.length > 0 ? episodes : undefined,
      };

      this.atomicWriteFile(this.filePath, serializeSnapshot(snapshot));
      return {
        ok: true,
        pushedCount: entities.length,
      };
    } catch (err) {
      return {
        ok: false,
        pushedCount: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async reconcile(context?: Context): Promise<ReconcileResult> {
    const pullRes = await this.pull(context);
    if (!pullRes.ok) {
      return {
        ok: false,
        pulledCount: 0,
        pushedCount: 0,
        totalCount: pullRes.localTotal,
        error: pullRes.error,
      };
    }

    const pushRes = await this.push(context);
    return {
      ok: pushRes.ok,
      pulledCount: pullRes.pulledCount,
      pushedCount: pushRes.pushedCount,
      totalCount: pullRes.localTotal,
      error: pushRes.error,
    };
  }

  private atomicWriteFile(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, path);
  }
}
