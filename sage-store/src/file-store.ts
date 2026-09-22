import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  type AppendResult,
  assignSeq,
  type EntityKey,
  type EntityState,
  type Episode,
  type EpisodeInput,
  entityKeyString,
  episodeToInput,
  foldEpisode,
  foldLog,
  InvalidArgumentError,
  type OpenResult,
  type StorePort,
  type StoreRegistries,
  validateEpisodeInput,
  validateLog,
} from '@sutras/sage-core';
import { CorruptStoreError, StoreClosedError, StoreLayoutError } from './errors.ts';
import { kindRegistryFor, resolveRegistries, signalRegistryFor } from './registries.ts';

/**
 * FilePolicyStore — a git-trackable, human-diffable StorePort backend (spec §7.1).
 *
 * One directory is one store. The whole foldable state (layout version, effective registries and
 * the episode log) lives in a single pretty-printed JSON document, `state.json`, so:
 *
 *   - it is **git-trackable and human-diffable** (the diff of an append reads like a review);
 *   - every commit is **atomic**: write-temp → fsync → roll the previous document into
 *     `state.json.bak` → rename — a crash at any point leaves either the new or the last good
 *     document, never a torn one;
 *   - `state.json.bak` is the **backup fallback**: if the main document is unreadable (garbage,
 *     truncation), open() folds the backup and reports corruption instead of crashing.
 *
 * Reading the log derives the entity projection (fold), exactly like every other backend — the
 * log is the source of truth. This backend is for policy-scale evidence, not volume; SQLite is
 * the volume backend. Writes refuse once corruption is known (consistent with the contract).
 */

const CURRENT_LAYOUT_VERSION = 1;

export interface StoreDocumentV1 {
  readonly layoutVersion: 1;
  /** The effective registries this store validates episodes against. */
  readonly registries: StoreRegistries;
  readonly episodes: readonly Episode[];
  /** Backend meta (e.g. the last-sweep marker). Additive, optional in layout 1. */
  readonly meta?: Record<string, string>;
}

/** Layout 0 (baseline): a bare `{ episodes }` document with no version or registries meta. */
interface StoreDocumentV0 {
  readonly episodes: readonly Episode[];
}

type StoreDocument = StoreDocumentV1 | StoreDocumentV0;

export interface FilePolicyStoreOptions {
  /** Directory that holds `state.json` / `state.json.bak`. Created on open(). */
  readonly dir: string;
  readonly registries?: StoreRegistries;
  /** Document file names (for tests that need to break them); default `state.json` / `.bak`. */
  readonly document?: string;
  readonly backup?: string;
}

export class FilePolicyStore implements StorePort {
  readonly name = 'file';

  private readonly dir: string;
  private readonly documentName: string;
  private readonly backupName: string;
  private readonly effective: StoreRegistries;
  private log: Episode[] = [];
  private projection = new Map<string, EntityState>();
  private nextSeq = 0;
  private opened = false;
  private loaded = false;
  private corruptAt: number | null = null;
  private readonly meta = new Map<string, string>();

  constructor(options: FilePolicyStoreOptions) {
    this.dir = options.dir;
    this.documentName = options.document ?? 'state.json';
    this.backupName = options.backup ?? 'state.json.bak';
    this.effective = resolveRegistries(options.registries);
  }

  get registries(): StoreRegistries {
    return { ...this.effective };
  }

  private get documentPath(): string {
    return join(this.dir, this.documentName);
  }

  private get backupPath(): string {
    return join(this.dir, this.backupName);
  }

  isOpen(): boolean {
    return this.opened;
  }

  async open(): Promise<OpenResult> {
    this.opened = true;
    if (!this.loaded) {
      this.loaded = true;
      mkdirSync(this.dir, { recursive: true });
      // A leftover temp file is a crashed commit, never a participant: the last good document
      // always survives (rename replaces file, never appends to it).
      const staleTemp = `${this.documentPath}.tmp`;
      if (existsSync(staleTemp)) rmSync(staleTemp, { force: true });

      const main = this.readDocument(this.documentPath);
      const backup = main === null ? this.readDocument(this.backupPath) : null;
      const doc = main ?? backup;

      if (
        main === null &&
        backup === null &&
        !existsSync(this.documentPath) &&
        !existsSync(this.backupPath)
      ) {
        // Brand-new store: an empty, current document. Nothing is "reset" here — nothing existed.
        return { status: 'ok' };
      }
      if (doc === null) {
        // Both documents unreadable: no snapshot to fall back to. Reads stay empty, writes refuse.
        this.corruptAt = 0;
        return { status: 'corrupt', location: { source: this.documentPath, atSeq: 0 } };
      }

      const migrated = this.migrateToV1(doc);
      this.meta.clear();
      for (const [metaKey, metaValue] of Object.entries(migrated.meta ?? {})) {
        this.meta.set(metaKey, metaValue);
      }
      const corrupted = main === null; // main unreadable → the backup is the last good snapshot.
      this.corruptAt = this.foldDocument(migrated, corrupted);
      return this.corruptAt === null
        ? { status: 'ok' }
        : { status: 'corrupt', location: { source: this.documentPath, atSeq: this.corruptAt } };
    }
    return this.corruptAt === null
      ? { status: 'ok' }
      : { status: 'corrupt', location: { source: this.documentPath, atSeq: this.corruptAt } };
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  async append(episodeInput: EpisodeInput): Promise<AppendResult> {
    this.assertOpen('append');
    if (this.corruptAt !== null) {
      throw new CorruptStoreError(
        { source: this.documentPath, atSeq: this.corruptAt },
        `Cannot append to corrupt store: log is unrecoverable from seq ${this.corruptAt}`,
      );
    }
    const kinds = kindRegistryFor(this.effective.kinds);
    const signals = signalRegistryFor(this.effective.signalSpecs);
    validateEpisodeInput(episodeInput, { kinds, signals });
    const episode = assignSeq(episodeInput, this.nextSeq);
    const state = this.accept(episode);
    this.persist();
    return { episode, state };
  }

  async replaceLog(
    episodes: readonly Episode[],
  ): Promise<{ readonly from: number; readonly to: number }> {
    this.assertOpen('replaceLog');
    if (this.corruptAt !== null) {
      throw new CorruptStoreError(
        { source: this.documentPath, atSeq: this.corruptAt },
        `Cannot replace the log of a corrupt store: unrecoverable from seq ${this.corruptAt}`,
      );
    }
    const kinds = kindRegistryFor(this.effective.kinds);
    const signals = signalRegistryFor(this.effective.signalSpecs);
    validateLog(episodes, { kinds, signals });
    const replaced = { from: 0, to: this.log.length - 1 };
    this.log = [];
    this.projection.clear();
    this.nextSeq = 0;
    for (const episode of episodes) this.accept(episode);
    this.persist();
    return replaced;
  }

  async getMeta(key: string): Promise<string | undefined> {
    this.assertOpen('getMeta');
    return this.meta.get(key);
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.assertOpen('setMeta');
    this.meta.set(key, value);
    this.persist();
  }

  async episodes(afterSeq?: number, limit?: number): Promise<Episode[]> {
    this.assertOpen('episodes');
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new InvalidArgumentError('episodes.limit', 'a positive safe integer', limit);
    }
    const from = afterSeq ?? -1;
    const sliced = this.log.filter((e) => e.seq > from);
    return limit === undefined ? sliced : sliced.slice(0, limit);
  }

  async get(key: EntityKey): Promise<EntityState | undefined> {
    this.assertOpen('get');
    return this.projection.get(entityKeyString(key));
  }

  async list(): Promise<EntityState[]> {
    this.assertOpen('list');
    return this.sortedProjection();
  }

  async rebuild(): Promise<EntityState[]> {
    this.assertOpen('rebuild');
    return foldLog(this.log);
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** Fold a loaded document's episodes into the live projection; returns the first bad seq or null. */
  private foldDocument(doc: StoreDocumentV1, alreadyCorrupt: boolean): number | null {
    const kinds = kindRegistryFor(this.effective.kinds);
    const signals = signalRegistryFor(this.effective.signalSpecs);
    const ordered = [...doc.episodes].sort((a, b) => a.seq - b.seq);
    for (const episode of ordered) {
      if (episode.seq !== this.nextSeq) {
        // A gap or duplicate is as much an unrecoverable log as an invalid episode.
        return episode.seq;
      }
      try {
        validateEpisodeInput(episodeToInput(episode), { kinds, signals });
      } catch (_failure) {
        return episode.seq;
      }
      this.accept(episode);
    }
    return alreadyCorrupt ? 0 : null;
  }

  private accept(episode: Episode): EntityState | undefined {
    this.log.push(episode);
    const key = entityKeyString(episode.key);
    const next = foldEpisode(this.projection.get(key), episode);
    if (next === undefined) this.projection.delete(key);
    else this.projection.set(key, next);
    this.nextSeq = episode.seq + 1;
    return next;
  }

  private sortedProjection(): EntityState[] {
    const entries = [...this.projection.entries()];
    entries.sort(([ka], [kb]) => (ka < kb ? -1 : 1));
    return entries.map(([, state]) => state);
  }

  /** Normalise a read document to the current layout. Layout 0 gains the meta; anything newer refuses. */
  private migrateToV1(doc: StoreDocument): StoreDocumentV1 {
    if ('layoutVersion' in doc) {
      if (doc.layoutVersion > CURRENT_LAYOUT_VERSION) {
        throw new StoreLayoutError(doc.layoutVersion, CURRENT_LAYOUT_VERSION);
      }
      if (doc.layoutVersion === 1) return doc;
    }
    return { layoutVersion: 1, registries: this.effective, episodes: [...doc.episodes] };
  }

  /** Try to parse one document file: `null` when it is missing, unreadable, or not a valid shape. */
  private readDocument(path: string): StoreDocument | null {
    if (!existsSync(path)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (_failure) {
      return null;
    }
    if (!isDocumentShape(parsed)) return null;
    return parsed;
  }

  /** Atomic commit: temp → fsync → roll prior doc into .bak → rename. Crash-safe at every point. */
  private persist(): void {
    const meta = this.meta.size === 0 ? {} : Object.fromEntries([...this.meta.entries()]);
    const doc: StoreDocumentV1 = {
      layoutVersion: 1,
      registries: this.effective,
      episodes: this.log,
      ...(Object.keys(meta).length === 0 ? {} : { meta }),
    };
    const tmp = `${this.documentPath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    fsyncFile(tmp);
    if (existsSync(this.documentPath)) {
      copyFileSync(this.documentPath, this.backupPath);
      fsyncFile(this.backupPath);
    }
    renameSync(tmp, this.documentPath);
    fsyncDirectory(this.dir);
  }

  private assertOpen(operation: string): void {
    if (!this.opened) throw new StoreClosedError(operation);
  }
}

function isDocumentShape(parsed: unknown): parsed is StoreDocument {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const candidate = parsed as { readonly layoutVersion?: unknown; readonly episodes?: unknown };
  if (typeof candidate.layoutVersion === 'number') {
    return Array.isArray(candidate.episodes);
  }
  // Layout 0: a bare episodes array.
  return Array.isArray(candidate.episodes);
}

function fsyncFile(path: string): void {
  const fd = openSync(path, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(path: string): void {
  try {
    const fd = openSync(path, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    // Directory fsync is a best-effort durability hint; it is unsupported on some platforms.
    void error;
  }
}
