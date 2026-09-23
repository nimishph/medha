/**
 * Maintenance plane (§6.4): the session-start sweep (§8), episode-limit compaction, preflight and
 * backup/restore.
 *
 * The decision logic is pure and lives here so every §8 rule is unit-testable without a store:
 *
 *   - `planSweep` turns the entity projection into the lifecycle steps the sweep must record
 *     (drift → quarantine, stale → retire, retention → archive + purge), in that order;
 *   - `compactPrefix` folds the log prefix older than a cutoff into one `BaselineEpisode` per
 *     entity and reports the folded range — the recomputability loss the spec requires to be
 *     named, not hidden.
 *
 * The `Sage` engine orchestrates the store around these, appends one episode per decision and
 * persists a last-sweep marker, so a sweep that runs is never silent and one that is skipped says
 * why.
 */

import {
  assignSeq,
  type BaselineEpisode,
  type CorruptLocation,
  DAY_MS,
  DRIFT_THRESHOLD,
  type EntityKey,
  type EntityState,
  type Episode,
  entityKeyString,
  episodeToInput,
  foldLog,
  InvalidArgumentError,
  isDrifting,
  RECENCY_FLOOR,
  recencyDecay,
  round6,
  type StoreRegistries,
} from '@cntxt-labs/medha-core';

/** Meta key holding the last sweep's epoch (ms), read/written through `StorePort.getMeta`. */
export const LAST_SWEEP_META_KEY = 'sweep:lastRun';

/** §8: the default session-start sweep throttle — at most once per 24 hours. */
export const DEFAULT_SWEEP_INTERVAL_MS = DAY_MS;

/** §8: the default episode-fold cutoff and the retention period before archive/purge. */
export const DEFAULT_FOLD_DAYS = 90;
export const DEFAULT_RETENTION_DAYS = 90;

/** Snapshot format marker written by `backup()` and required by `restore()`. */
export const SNAPSHOT_FORMAT = 'sutras.medha/v1';

// ---------------------------------------------------------------------------------------------
// report contracts (§6.4)
// ---------------------------------------------------------------------------------------------

/** §8 lifecycle actions the sweep can record (each becomes an episode). */
export type SweepActionKind = 'quarantine' | 'retire' | 'archive' | 'purge';

/** Options for the session-start sweep (`open`). All are host-overridable (§8). */
export interface SweepOptions {
  /** Minimum gap between sweeps, ms; default once per 24 h. */
  readonly sweepEvery?: number;
  /** Retired entities left this many days are archived then purged. */
  readonly retentionDays?: number;
  /** Episodes older than this many days fold into baselines. */
  readonly olderThan?: number;
}

export interface SweepChange {
  /** The episode's sequence number in the log. */
  readonly seq: number;
  readonly action: SweepActionKind;
  readonly key: EntityKey;
  readonly reason: string;
  /** The episode clock (normally `context.now`). */
  readonly at: number;
}

/** A contiguous seq range on the log; inclusive. */
export interface FoldedRange {
  readonly from: number;
  readonly to: number;
}

/** What episode-compaction did this session. Always reported, even when nothing qualified. */
export interface CompactSection {
  /** The range whose recomputability is lost; `null` when nothing was older than the cutoff. */
  readonly folded: FoldedRange | null;
  readonly baselinesWritten: number;
  /** Episodes left after compaction (the compacted part of the log). */
  readonly remainingEpisodes: number;
}

export interface SweepReport {
  readonly asOf: number;
  readonly retentionDays: number;
  readonly olderThanDays: number;
  /** Every lifecycle change made, one per §8 rule that fired. */
  readonly changes: readonly SweepChange[];
  readonly quarantineCount: number;
  readonly retireCount: number;
  readonly archiveCount: number;
  readonly purgeCount: number;
  readonly compact: CompactSection;
}

export type SweepSkipped =
  | {
      readonly skipped: 'within-interval';
      readonly asOf: number;
      readonly lastSweep: number;
      readonly dueAt: number;
    }
  | {
      readonly skipped: 'store-corrupt';
      readonly asOf: number;
      readonly location: CorruptLocation;
    };

export type SessionOpenResult = SweepReport | SweepSkipped;

export interface CompactionReport {
  readonly asOf: number;
  readonly olderThanDays: number;
  readonly cutoffAt: number;
  /** The range folded away; `null` when nothing qualified. */
  readonly compacted: FoldedRange | null;
  readonly baselinesWritten: number;
  readonly remainingEpisodes: number;
  readonly entities: number;
}

export interface PreflightReport {
  readonly asOf: number;
  readonly status: 'ok' | 'corrupt';
  readonly location: CorruptLocation | null;
  readonly episodeCount: number;
  readonly entityCount: number;
  readonly integrity: 'ok' | 'fold-mismatch';
  readonly lastSweep: number | null;
  readonly registries: {
    readonly kinds: number;
    readonly signals: number;
    readonly anchors: number;
  };
}

/** A portable, JSON-serialisable capture of the store's source of truth (§6.4 backup/restore). */
export interface MedhaSnapshot {
  readonly format: typeof SNAPSHOT_FORMAT;
  /** When the snapshot was taken. Purely informational — restore never consults it. */
  readonly exportedAt: number;
  /** The registries the snapshot was taken under (restore validates the log against its host store). */
  readonly registries: StoreRegistries;
  readonly episodes: readonly Episode[];
  /** Engine-owned meta (the last-sweep marker). Restore overwrites the keys present here. */
  readonly meta: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------------------------
// option/validation helpers
// ---------------------------------------------------------------------------------------------

/** A sweep option: positive finite, or its default when absent. */
export function resolveSweepOption(
  name: string,
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new InvalidArgumentError(name, 'a positive finite number', value);
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// pure sweep planning (§8 rows 1–3)
// ---------------------------------------------------------------------------------------------

export interface SweepStep {
  readonly key: EntityKey;
  readonly action: SweepActionKind;
  readonly reason: string;
}

export interface SweepPlanOptions {
  /** Retired for at least this long (ms) → archived, then purged. */
  readonly retentionMs: number;
}

/**
 * Decide every lifecycle step one sweep must record (drift → quarantine, stale → retire,
 * retention → archive + purge), in §8 order. Deterministic: it walks `states` in index order and
 * each rule is a pure function of a single state, so the same store + `now` plan the same steps.
 *
 * Safety (§8): states under a human `override` are never touched; probation entities still
 * gathering first evidence and entities with no evidence since their last restore are never
 * pruned as stale; quarantine and retire are reversible states, only the final purge is not.
 */
export function planSweep(
  states: readonly EntityState[],
  now: number,
  options: SweepPlanOptions,
): SweepStep[] {
  const steps: SweepStep[] = [];

  for (const state of states) {
    // §5.3: an explicit lifecycle override is terminal until a human restore. The sweep never
    // second-guesses it.
    if (state.override !== null) continue;

    if (state.status === 'retired') {
      // A retired entity without a retirement stamp can never age into retention. Stamp it so the
      // retention clock exists (covers math-retired states that predate lifecycle stamps).
      if (state.retiredAt === null) {
        steps.push({
          key: state.key,
          action: 'retire',
          reason: 'consistency: retired without a retirement timestamp, so retention cannot act',
        });
      }
      continue;
    }

    if (state.status === 'quarantined') {
      // Drift (Δ ≥ 0.40, n ≥ 3) → quarantine, made durable as an override so a converging EMA
      // cannot unsay it behind the host's back. A guard-failed quarantine is the fold's to manage.
      if (isDrifting(state.ema.mu, state.ema.theta0, state.evidence.n)) {
        steps.push({
          key: state.key,
          action: 'quarantine',
          reason: `drift: delta ${driftDeltaText(state)} >= ${DRIFT_THRESHOLD} after ${state.evidence.n} trials`,
        });
      }
      continue;
    }

    if (isDrifting(state.ema.mu, state.ema.theta0, state.evidence.n)) {
      steps.push({
        key: state.key,
        action: 'quarantine',
        reason: `drift: delta ${driftDeltaText(state)} >= ${DRIFT_THRESHOLD} after ${state.evidence.n} trials`,
      });
      continue;
    }

    // Stale: recency at its floor and no new evidence → retire.
    if (state.evidence.n === 0) continue; // probation still gathering first evidence
    if (
      state.restoredAt !== null &&
      (state.lastSignalAt === null || state.lastSignalAt < state.restoredAt)
    ) {
      continue; // no evidence since the restore — treated as "just restored"
    }
    if (state.lastSignalAt === null) continue; // defensive: n > 0 implies a signal stamped one
    if (recencyDecay(state.lastSignalAt, now) === RECENCY_FLOOR) {
      steps.push({
        key: state.key,
        action: 'retire',
        reason: `stale: recency at floor (last signal ${ageDaysText(now - state.lastSignalAt)}d ago) and no new evidence`,
      });
    }
  }

  // Retention: retired longer than the window → archived, then purged (row 3). Freshly retired
  // states (this run or recent) carry a recent `retiredAt` and cannot qualify.
  for (const state of states) {
    if (state.status !== 'retired' || state.retiredAt === null) continue;
    const ageMs = now - state.retiredAt;
    if (ageMs >= options.retentionMs) {
      steps.push({
        key: state.key,
        action: 'archive',
        reason: `retention: retired ${ageDaysText(ageMs)}d ago, archiving before purge`,
      });
      steps.push({
        key: state.key,
        action: 'purge',
        reason: `retention: retired ${ageDaysText(ageMs)}d ago, past the ${ageDaysText(options.retentionMs)}d window`,
      });
    }
  }

  return steps;
}

// ---------------------------------------------------------------------------------------------
// pure episode compaction (§8 row 4)
// ---------------------------------------------------------------------------------------------

export interface CompactedLog {
  /** The seq-contiguous log to install (baselines + the un-folded suffix). */
  readonly episodes: readonly Episode[];
  /** The input range folded away; `null` when nothing qualified. */
  readonly folded: FoldedRange | null;
  readonly baselinesWritten: number;
}

/**
 * Fold the log prefix strictly older than `cutoffAt` into one `BaselineEpisode` per entity that
 * still has a state there, keeping the log contiguous from seq 0. A baseline reproduces the
 * folded prefix, so the result is fold-equivalent — the `Sage` engine verifies that against the
 * live store rather than trusting it.
 */
export function compactPrefix(log: readonly Episode[], cutoffAt: number): CompactedLog {
  const ordered = [...log].sort((a, b) => a.seq - b.seq);
  let border = -1;
  for (let i = 0; i < ordered.length; i++) {
    const episode = ordered[i];
    if (episode === undefined) break;
    if (episode.at >= cutoffAt) break;
    border = i;
  }
  if (border < 0) return { episodes: ordered, folded: null, baselinesWritten: 0 };

  const prefix = ordered.slice(0, border + 1);
  const suffix = ordered.slice(border + 1);
  const states = foldLog(prefix);

  // The checkpoint clock: the last time each entity changed inside the folded prefix.
  const lastAt = new Map<string, number>();
  for (const episode of prefix) {
    const key = entityKeyString(episode.key);
    const prior = lastAt.get(key);
    if (prior === undefined || episode.at > prior) lastAt.set(key, episode.at);
  }

  const baselines: BaselineEpisode[] = states.map((state) => {
    const at = lastAt.get(entityKeyString(state.key));
    return {
      type: 'baseline',
      seq: 0, // renumbered below
      key: state.key,
      at: at ?? cutoffAt,
      state,
    };
  });

  const renumbered = [...baselines, ...suffix].map((episode, seq) =>
    assignSeq(episodeToInput(episode), seq),
  );

  return {
    episodes: renumbered,
    folded: { from: 0, to: border },
    baselinesWritten: states.length,
  };
}

// ---------------------------------------------------------------------------------------------
// state-equality (fold-equivalence gates)
// ---------------------------------------------------------------------------------------------

/** Structural equality of two projections — the guard compaction and preflight rely on. */
export function statesEquivalent(a: readonly EntityState[], b: readonly EntityState[]): boolean {
  if (a.length !== b.length) return false;
  const byKey = new Map(b.map((state) => [entityKeyString(state.key), state]));
  return a.every((state) => sameState(state, byKey.get(entityKeyString(state.key))));
}

function sameState(a: EntityState, b: EntityState | undefined): boolean {
  if (b === undefined) return false;
  return (
    entityKeyString(a.key) === entityKeyString(b.key) &&
    a.evidence.k === b.evidence.k &&
    a.evidence.n === b.evidence.n &&
    a.evidence.contextRejects === b.evidence.contextRejects &&
    a.ema.mu === b.ema.mu &&
    a.ema.theta0 === b.ema.theta0 &&
    a.ema.updatedAt === b.ema.updatedAt &&
    a.guard.kind === b.guard.kind &&
    a.guard.lastOk === b.guard.lastOk &&
    a.guard.lastOkAt === b.guard.lastOkAt &&
    a.anchors.length === b.anchors.length &&
    a.anchors.every(
      (anchor, i) => anchor.kind === b.anchors[i]?.kind && anchor.value === b.anchors[i]?.value,
    ) &&
    a.status === b.status &&
    a.override === b.override &&
    a.retiredAt === b.retiredAt &&
    a.restoredAt === b.restoredAt &&
    a.updater === b.updater &&
    a.createdAt === b.createdAt &&
    a.lastSignalAt === b.lastSignalAt
  );
}

function driftDeltaText(state: EntityState): string {
  return String(round6(Math.abs(state.ema.mu - state.ema.theta0)));
}

function ageDaysText(ms: number): string {
  return String(Math.round(ms / DAY_MS));
}
