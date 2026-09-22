import {
  type AppendResult,
  assignSeq,
  type EntityKey,
  type EntityState,
  type Episode,
  type EpisodeInput,
  entityKeyString,
  foldEpisode,
  foldLog,
  InvalidArgumentError,
  type OpenResult,
  type StorePort,
  type StoreRegistries,
  validateEpisodeInput,
} from '@sutras/sage-core';
import { CorruptStoreError, StoreClosedError } from './errors.ts';
import { kindRegistryFor, resolveRegistries, signalRegistryFor } from './registries.ts';

/**
 * In-memory StorePort backend.
 *
 * Ephemeral by design (tests, CI, single-process embedding): nothing touches disk. It exists to
 * (a) prove the contract and (b) give the engine a zero-setup store, and the contract suite it
 * satisfies is the same one file and SQLite backends must satisfy later — no per-backend branch.
 *
 * State is a fold over the episode log: every append re-folds keys it touches, and `rebuild()`
 * re-folds the whole log from scratch so fold-equivalence is checkable and cheap to verify.
 */

export interface MemoryStoreOptions {
  /** A pre-existing log to load at `open()`, simulating what a durable backend reads from disk. */
  readonly initialEpisodes?: readonly Episode[];
  readonly registries?: StoreRegistries;
}

export class MemoryStore implements StorePort {
  readonly name = 'memory';

  private readonly initialEpisodes: readonly Episode[];
  private log: Episode[] = [];
  private projection = new Map<string, EntityState>();
  private nextSeq = 0;
  private opened = false;
  private loaded = false;
  private corruptAt: number | null = null;
  private readonly baseRegistries: StoreRegistries;
  constructor(options: MemoryStoreOptions = {}) {
    this.initialEpisodes = options.initialEpisodes ?? [];
    // Built-ins are always present; the host's lists are additive (see resolveRegistries).
    this.baseRegistries = resolveRegistries(options.registries);
  }
  get registries(): StoreRegistries {
    return { ...this.baseRegistries };
  }

  isOpen(): boolean {
    return this.opened;
  }

  async open(): Promise<OpenResult> {
    this.opened = true;
    if (!this.loaded) {
      this.loaded = true;
      const kinds = kindRegistryFor(this.baseRegistries.kinds);
      const signals = signalRegistryFor(this.baseRegistries.signalSpecs);
      const validation = { kinds, signals };

      for (const episode of this.initialEpisodes) {
        try {
          validateEpisodeInput(episodeToInput(episode), validation);
        } catch (_failure) {
          this.corruptAt = episode.seq;
          return {
            status: 'corrupt',
            location: { source: '', atSeq: episode.seq },
          };
        }
        this.accept(episode);
      }
    }
    return this.corruptAt === null
      ? { status: 'ok' }
      : { status: 'corrupt', location: { source: '', atSeq: this.corruptAt } };
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  async append(episodeInput: EpisodeInput): Promise<AppendResult> {
    this.assertOpen('append');
    if (this.corruptAt !== null) {
      throw new CorruptStoreError(
        { source: '', atSeq: this.corruptAt },
        `Cannot append to corrupt store: log is unrecoverable from seq ${this.corruptAt}`,
      );
    }
    const kinds = kindRegistryFor(this.baseRegistries.kinds);
    const signals = signalRegistryFor(this.baseRegistries.signalSpecs);
    validateEpisodeInput(episodeInput, { kinds, signals });
    const episode = assignSeq(episodeInput, this.nextSeq);
    const state = this.accept(episode);
    return { episode, state };
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
    return [...this.projection.values()].sort((a, b) =>
      entityKeyString(a.key) < entityKeyString(b.key) ? -1 : 1,
    );
  }

  async rebuild(): Promise<EntityState[]> {
    this.assertOpen('rebuild');
    return foldLog(this.log);
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

  private assertOpen(operation: string): void {
    if (!this.opened) throw new StoreClosedError(operation);
  }
}

function episodeToInput(episode: Episode): EpisodeInput {
  const { seq: _seq, ...rest } = episode;
  return rest as EpisodeInput;
}
