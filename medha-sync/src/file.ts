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
import { mergeEpisodes } from './merge.ts';

export interface FileSyncOptions {
  readonly store: StorePort;
  readonly filePath: string;
}

export class FileSyncAdapter implements SyncPort {
  readonly name = 'file';
  readonly store: StorePort;
  readonly filePath: string;

  /**
   * Raw content of `filePath` as last observed by this instance (via pull()), or `null` if it
   * was observed absent. `undefined` means this instance has never read the file, in which case
   * push() has nothing to compare against and writes unconditionally (matching a bare push()
   * with no prior pull/reconcile).
   */
  private lastObservedContent: string | null | undefined;

  constructor(options: FileSyncOptions) {
    this.store = options.store;
    this.filePath = resolve(options.filePath);
  }

  private readRawFile(): string | null {
    return existsSync(this.filePath) ? readFileSync(this.filePath, 'utf8') : null;
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

  async peek(_context?: Context): Promise<MemorySnapshotV1 | null> {
    if (!existsSync(this.filePath)) {
      return null;
    }
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8'));
      return migrateSnapshot(raw);
    } catch {
      return null;
    }
  }

  async pull(_context?: Context): Promise<PullResult> {
    const localStates = await this.store.list();
    const rawFile = this.readRawFile();
    if (rawFile === null) {
      this.lastObservedContent = null;
      return {
        ok: true,
        updated: false,
        pulledCount: 0,
        localTotal: localStates.length,
      };
    }

    try {
      const raw = JSON.parse(rawFile);
      const snapshot = migrateSnapshot(raw);
      this.lastObservedContent = rawFile;
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

      // Episodes already match (or the remote sent none): entity state is strictly a
      // fold over the episode log, and StorePort exposes no path to write it directly.
      // Nothing was, or could be, persisted here, so report that honestly instead of
      // implying entities were merged.
      return {
        ok: true,
        updated: false,
        pulledCount: 0,
        localTotal: localStates.length,
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
      // Expected-previous-content guard (CAS), mirroring the git adapter's
      // expected-old-value ref update: if this instance has read the file before
      // (via pull()) and it has since changed on disk, refuse to blindly overwrite
      // a concurrent writer's update.
      if (this.lastObservedContent !== undefined) {
        const currentRaw = this.readRawFile();
        if (currentRaw !== this.lastObservedContent) {
          return {
            ok: false,
            pushedCount: 0,
            error: `Sync file diverged: ${this.filePath} changed since last pull. Pull again before pushing.`,
          };
        }
      }

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

      const serialized = serializeSnapshot(snapshot);
      this.atomicWriteFile(this.filePath, serialized);
      this.lastObservedContent = serialized;
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
