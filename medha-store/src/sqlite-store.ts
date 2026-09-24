import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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
  UnknownKindError,
  validateEpisodeInput,
  validateLog,
} from '@cntxt-labs/medha-core';
import { CorruptStoreError, StoreClosedError, StoreLayoutError } from './errors.ts';
import { kindRegistryFor, resolveRegistries, signalRegistryFor } from './registries.ts';

/**
 * SQLiteStore — the volume StorePort backend (spec §7.1), with `bun:sqlite` and no extra deps.
 *
 * The episode log is a real table (`seq` primary key, full episode JSON per row) so reads of a
 * tail are a bounded query, not a rewrite of the log — this is the backend volume lands on. The
 * entity projection is an in-memory fold over the log, rebuilt from it on open (fold-equivalence
 * keeps the projection a pure function of the log). WAL + `synchronous=FULL` give crash-safe
 * commits; each append is one transaction, so seq assignment and the fold never tear.
 *
 * Corruption behaves like every backend: `open()` validates the whole loadable prefix, reports
 * the first bad seq, keeps the healthy prefix served for reads, and refuses writes until repair.
 */

const CURRENT_LAYOUT_VERSION = 1;

export interface SQLiteStoreOptions {
  /** SQLite database file path. Created (with schema) on open(). */
  readonly path: string;
  readonly registries?: StoreRegistries;
  /** When true, unknown historical kinds during log replay are preserved rather than halting the store. */
  readonly resilientReplay?: boolean;
}

export class SQLiteStore implements StorePort {
  readonly name = 'sqlite';

  private readonly path: string;
  private effective: StoreRegistries;
  private readonly resilientReplay: boolean;
  private db: Database | null = null;
  private log: Episode[] = [];
  private projection = new Map<string, EntityState>();
  private nextSeq = 0;
  private opened = false;
  private loaded = false;
  private corruptAt: number | null = null;

  constructor(options: SQLiteStoreOptions) {
    this.path = options.path;
    this.effective = resolveRegistries(options.registries);
    this.resilientReplay = options.resilientReplay ?? false;
  }

  get registries(): StoreRegistries {
    return { ...this.effective };
  }

  isOpen(): boolean {
    return this.opened;
  }

  async open(): Promise<OpenResult> {
    this.opened = true;
    // Every open re-establishes the connection (close() releases it); the ingestion loop below
    // runs once per stored configuration so a reopen never double-folds the log.
    mkdirSync(dirname(this.path), { recursive: true });
    const db = new Database(this.path, { create: true });
    this.db = db;
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA synchronous = FULL');
    db.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.run('CREATE TABLE IF NOT EXISTS episodes (seq INTEGER PRIMARY KEY, json TEXT NOT NULL)');

    if (!this.loaded) {
      this.loaded = true;
      const layout = this.readMeta(db, 'layout');
      if (layout === undefined) {
        // Layout 0 baseline: an empty database with no meta yet. Migrate by stamping version 1.
        this.writeMeta(db, 'layout', String(CURRENT_LAYOUT_VERSION));
      } else if (Number(layout) > CURRENT_LAYOUT_VERSION) {
        throw new StoreLayoutError(Number(layout), CURRENT_LAYOUT_VERSION);
      }

      const rows = db
        .query<{ seq: number; json: string }, []>('SELECT seq, json FROM episodes ORDER BY seq')
        .all();
      const kinds = kindRegistryFor(this.effective.kinds);
      const signals = signalRegistryFor(this.effective.signalSpecs);
      for (const row of rows) {
        let episode: Episode;
        try {
          episode = JSON.parse(row.json) as Episode;
        } catch (_failure) {
          this.corruptAt = row.seq;
          break;
        }
        if (episode.seq !== this.nextSeq) {
          this.corruptAt = row.seq;
          break;
        }
        try {
          validateEpisodeInput(episodeToInput(episode), { kinds, signals });
        } catch (failure) {
          if (this.resilientReplay && failure instanceof UnknownKindError) {
            kinds.register(episode.key.kind);
            if (!this.effective.kinds.includes(episode.key.kind)) {
              this.effective = {
                ...this.effective,
                kinds: [...this.effective.kinds, episode.key.kind],
              };
            }
          } else {
            this.corruptAt = row.seq;
            break;
          }
        }
        this.accept(episode);
      }
    }
    return this.corruptAt === null
      ? { status: 'ok' }
      : { status: 'corrupt', location: { source: this.path, atSeq: this.corruptAt } };
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
    this.opened = false;
  }

  async append(episodeInput: EpisodeInput): Promise<AppendResult> {
    this.assertOpen('append');
    const db = this.requireDb();
    if (this.corruptAt !== null) {
      throw new CorruptStoreError(
        { source: this.path, atSeq: this.corruptAt },
        `Cannot append to corrupt store: log is unrecoverable from seq ${this.corruptAt}`,
      );
    }
    const kinds = kindRegistryFor(this.effective.kinds);
    const signals = signalRegistryFor(this.effective.signalSpecs);
    validateEpisodeInput(episodeInput, { kinds, signals });
    const episode = assignSeq(episodeInput, this.nextSeq);
    db.transaction(() => {
      db.query('INSERT INTO episodes (seq, json) VALUES (?, ?)').run(
        episode.seq,
        JSON.stringify(episode),
      );
    })();
    const state = this.accept(episode);
    return { episode, state };
  }

  async episodes(afterSeq?: number, limit?: number): Promise<Episode[]> {
    this.assertOpen('episodes');
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new InvalidArgumentError('episodes.limit', 'a positive safe integer', limit);
    }
    // Serve the fold-consistent prefix (the loadable snapshot): rows at or past a corrupt seq are
    // not part of the log until the store is repaired.
    const from = afterSeq ?? -1;
    const cursor = this.corruptAt ?? Number.POSITIVE_INFINITY;
    const sliced = this.log.filter((e) => e.seq > from && e.seq < cursor);
    return limit === undefined ? sliced : sliced.slice(0, limit);
  }

  async get(key: EntityKey): Promise<EntityState | undefined> {
    this.assertOpen('get');
    return this.projection.get(entityKeyString(key));
  }

  async list(): Promise<EntityState[]> {
    this.assertOpen('list');
    const entries = [...this.projection.entries()];
    entries.sort(([ka], [kb]) => (ka < kb ? -1 : 1));
    return entries.map(([, state]) => state);
  }

  async rebuild(): Promise<EntityState[]> {
    this.assertOpen('rebuild');
    return foldLog(this.log);
  }

  async replaceLog(
    episodes: readonly Episode[],
  ): Promise<{ readonly from: number; readonly to: number }> {
    this.assertOpen('replaceLog');
    if (this.corruptAt !== null) {
      throw new CorruptStoreError(
        { source: this.path, atSeq: this.corruptAt },
        `Cannot replace the log of a corrupt store: unrecoverable from seq ${this.corruptAt}`,
      );
    }
    const db = this.requireDb();
    const kinds = kindRegistryFor(this.effective.kinds);
    const signals = signalRegistryFor(this.effective.signalSpecs);
    validateLog(episodes, { kinds, signals });
    const replaced = { from: 0, to: this.log.length - 1 };
    db.transaction(() => {
      db.query('DELETE FROM episodes').run();
      const insert = db.query('INSERT INTO episodes (seq, json) VALUES (?, ?)');
      for (const episode of episodes) insert.run(episode.seq, JSON.stringify(episode));
    })();
    this.log = [];
    this.projection.clear();
    this.nextSeq = 0;
    for (const episode of episodes) this.accept(episode);
    return replaced;
  }

  async getMeta(key: string): Promise<string | undefined> {
    this.assertOpen('getMeta');
    return this.readMeta(this.requireDb(), key);
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.assertOpen('setMeta');
    this.writeMeta(this.requireDb(), key, value);
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private accept(episode: Episode): EntityState | undefined {
    this.log.push(episode);
    if (episode.type === 'retract') {
      const rebuilt = foldLog(this.log);
      this.projection.clear();
      for (const st of rebuilt) {
        this.projection.set(entityKeyString(st.key), st);
      }
      this.nextSeq = episode.seq + 1;
      return this.projection.get(entityKeyString(episode.key));
    }
    const key = entityKeyString(episode.key);
    const next = foldEpisode(this.projection.get(key), episode);
    if (next === undefined) this.projection.delete(key);
    else this.projection.set(key, next);
    this.nextSeq = episode.seq + 1;
    return next;
  }

  private requireDb(): Database {
    if (this.db === null) throw new StoreClosedError('operation');
    return this.db;
  }

  private readMeta(db: Database, key: string): string | undefined {
    const row = db
      .query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?')
      .get(key);
    return row?.value;
  }

  private writeMeta(db: Database, key: string, value: string): void {
    db.query(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
  }

  private assertOpen(operation: string): void {
    if (!this.opened) throw new StoreClosedError(operation);
  }
}
