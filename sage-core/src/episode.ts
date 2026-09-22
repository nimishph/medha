import type { Anchor } from './durability.ts';
import { type EntityKey, type EntityState, freshState } from './entity.ts';
import { assertNever, InvalidArgumentError } from './errors.ts';
import {
  applySignal,
  type GuardReport,
  type Override,
  overrideStatus,
  reportGuard,
  type SignalApplication,
} from './fold.ts';
import type { KindRegistry } from './kinds.ts';
import type { SignalRegistry, SignalSpec } from './signals.ts';
import { validateSignalSpec } from './signals.ts';
import { statusFor } from './trust.ts';

/**
 * Episodes, library spec §3 and §7.1.
 *
 * An episode is one immutable evidence event: a signal, a guard report, a human override, a
 * proposal, or a sweep action. The episode log is the append-only **source of truth**: entity
 * state is a fold over episodes, so any backend can rebuild it and it can be recomputed under
 * new parameters.
 *
 * Episodes are self-describing: a signal episode embeds the resolved `SignalSpec` (not a bare
 * name), so the fold is a pure function of the log — no mutable registries in the way, which is
 * what makes two replicas that merge logs deterministically equal.
 */

export interface BaseEpisode {
  /** Assigned by the store on append; strictly increasing, the log's order. */
  readonly seq: number;
  readonly key: EntityKey;
  /** When the event happened, in epoch ms. Serves as the fold's clock for determinism. */
  readonly at: number;
}

export interface SignalEpisode extends BaseEpisode {
  readonly type: 'signal';
  /** The resolved spec, embedded so the fold needs no registry. */
  readonly spec: SignalSpec;
  /** Anchor values observed at this use; the fold adds the calendar-week fallback if absent. */
  readonly anchors?: readonly Anchor[];
  /** Unknown id: create the entity only when the host passes `ensure: true` (spec §5.2). */
  readonly ensure: boolean;
  /** Optional run / session attribution for the read plane. */
  readonly runRef?: string;
  /** Free-form note from the write plane (e.g. host justification); the fold ignores it. */
  readonly note?: string;
  /**
   * The weight-updater that produced `weight`, when the write plane used one. Self-describing:
   * the fold needs no registry to apply the episode.
   */
  readonly updater?: string;
  /**
   * Post-fold `ema.mu` computed by the configured weight-updater. When present the fold uses this
   * instead of re-deriving the EMA step, so non-EMA strategies (wilson, sliding-window,
   * asymmetric) are real without ever breaking fold-equivalence.
   */
  readonly weight?: number;
}

export interface GuardEpisode extends BaseEpisode {
  readonly type: 'guard';
  readonly ok: boolean;
  /** Name of the guard the host ran; defaults to the entity's current guard kind. */
  readonly kind?: string;
  readonly ensure: boolean;
}

export interface OverrideEpisode extends BaseEpisode {
  readonly type: 'override';
  readonly override: Override;
  readonly reason: string;
}

export interface ProposalEpisode extends BaseEpisode {
  readonly type: 'proposal';
  /** Who mined this (digest clusterer, host policy, …); shown with the entity. */
  readonly provenance: string;
  /** Prior for the fresh probation entity; defaults to DEFAULT_THETA0. */
  readonly theta0?: number;
  readonly description?: string;
}

export type SweepAction = 'quarantine' | 'retire' | 'restore' | 'archive' | 'purge';

export interface SweepEpisode extends BaseEpisode {
  readonly type: 'sweep';
  readonly action: SweepAction;
  readonly reason: string;
}

export type Episode =
  | SignalEpisode
  | GuardEpisode
  | OverrideEpisode
  | ProposalEpisode
  | SweepEpisode;

/** An episode the host submits: everything but the store-assigned `seq`. */
export type EpisodeInput =
  | Omit<SignalEpisode, 'seq'>
  | Omit<GuardEpisode, 'seq'>
  | Omit<OverrideEpisode, 'seq'>
  | Omit<ProposalEpisode, 'seq'>
  | Omit<SweepEpisode, 'seq'>;

/** Deterministic map key for an entity. The separator is NUL (illegal in ids). */
export function entityKeyString(key: EntityKey): string {
  return `${key.namespace}\u0000${key.kind}\u0000${key.id}`;
}

/** A registries-backed validation context for episodes entering the log. */
export interface EpisodeValidation {
  readonly kinds: KindRegistry;
  readonly signals: SignalRegistry;
}

/**
 * Validate an episode before it enters the log. Unknown kinds fail loud with the registered
 * ones (spec §5.2); signal specs must satisfy the invariants and resolve in the registry; ids
 * and anchors must be well-formed. The store runs this on every append and again when a log is
 * opened — the check that finds a failing episode at open time is what flags a corrupt store.
 */
export function validateEpisodeInput(input: EpisodeInput, validation: EpisodeValidation): void {
  if (!Number.isFinite(input.at)) {
    throw new InvalidArgumentError('episode.at', 'a finite epoch-ms timestamp', input.at);
  }
  if (typeof input.key.namespace !== 'string') {
    throw new InvalidArgumentError('episode.key.namespace', 'a string', input.key.namespace);
  }
  if (typeof input.key.id !== 'string' || input.key.id.trim() === '') {
    throw new InvalidArgumentError('episode.key.id', 'a non-empty string', input.key.id);
  }
  validation.kinds.requireKnown(input.key.kind);

  switch (input.type) {
    case 'signal': {
      validateSignalSpec(input.spec);
      validation.signals.resolve(input.spec.name);
      for (const anchor of input.anchors ?? []) {
        if (typeof anchor.kind !== 'string' || anchor.kind === '') {
          throw new InvalidArgumentError(
            'episode.anchors[].kind',
            'a non-empty string',
            anchor.kind,
          );
        }
        if (typeof anchor.value !== 'string' || anchor.value === '') {
          throw new InvalidArgumentError(
            'episode.anchors[].value',
            'a non-empty string',
            anchor.value,
          );
        }
      }
      if (
        input.updater !== undefined &&
        (typeof input.updater !== 'string' || input.updater.trim() === '')
      ) {
        throw new InvalidArgumentError('episode.updater', 'a non-empty string', input.updater);
      }
      if (
        input.weight !== undefined &&
        (typeof input.weight !== 'number' ||
          !Number.isFinite(input.weight) ||
          input.weight < 0 ||
          input.weight > 1)
      ) {
        throw new InvalidArgumentError('episode.weight', 'a finite number in [0,1]', input.weight);
      }
      if (
        input.note !== undefined &&
        (typeof input.note !== 'string' || input.note.trim() === '')
      ) {
        throw new InvalidArgumentError('episode.note', 'a non-empty string', input.note);
      }
      break;
    }
    case 'guard':
      break;
    case 'override':
      if (typeof input.reason !== 'string' || input.reason.trim() === '') {
        throw new InvalidArgumentError('episode.reason', 'a non-empty string', input.reason);
      }
      break;
    case 'proposal':
      if (typeof input.provenance !== 'string' || input.provenance.trim() === '') {
        throw new InvalidArgumentError(
          'episode.provenance',
          'a non-empty string',
          input.provenance,
        );
      }
      if (input.theta0 !== undefined && (input.theta0 < 0 || input.theta0 > 1)) {
        throw new InvalidArgumentError('episode.theta0', 'a number in [0,1]', input.theta0);
      }
      break;
    case 'sweep':
      if (typeof input.reason !== 'string' || input.reason.trim() === '') {
        throw new InvalidArgumentError('episode.reason', 'a non-empty string', input.reason);
      }
      break;
    default:
      assertNever(input, 'episode input type');
  }
}

/** Tag a submitted episode with its store-assigned sequence number. */
export function assignSeq(input: EpisodeInput, seq: number): Episode {
  switch (input.type) {
    case 'signal':
      return { ...input, seq };
    case 'guard':
      return { ...input, seq };
    case 'override':
      return { ...input, seq };
    case 'proposal':
      return { ...input, seq };
    case 'sweep':
      return { ...input, seq };
    default:
      return assertNever(input, 'episode input type');
  }
}

/**
 * Fold one episode into prior state. `at` is the fold's clock, so the same episode applied at
 * the same timestamp always produces the same state. Returns `undefined` when the episode has
 * no effect on the key (no entity and no `ensure`, or a purge).
 */
export function foldEpisode(
  prev: EntityState | undefined,
  episode: Episode,
): EntityState | undefined {
  switch (episode.type) {
    case 'signal': {
      if (prev === undefined) {
        if (!episode.ensure) return undefined;
        prev = freshState(episode.key, episode.at);
      }
      const applied: SignalApplication =
        episode.anchors === undefined
          ? { spec: episode.spec }
          : { spec: episode.spec, anchors: episode.anchors };
      const base = applySignal(prev, applied, { now: episode.at }).state;
      if (episode.weight === undefined) return base;
      // Self-describing weight-updater result: the episode carries the mu the configured strategy
      // produced, and the fold re-derives status from it — determinism, no registry in the way.
      const withWeight: EntityState = {
        ...base,
        ema: { mu: episode.weight, theta0: prev.ema.theta0, updatedAt: episode.at },
      };
      const status = statusFor(withWeight, episode.at);
      return { ...withWeight, status };
    }
    case 'guard': {
      if (prev === undefined) {
        if (!episode.ensure) return undefined;
        prev = freshState(episode.key, episode.at);
      }
      const report: GuardReport =
        episode.kind === undefined ? { ok: episode.ok } : { ok: episode.ok, kind: episode.kind };
      return reportGuard(prev, report, { now: episode.at }).state;
    }
    case 'override': {
      if (prev === undefined) return undefined;
      return overrideStatus(prev, episode.override).state;
    }
    case 'proposal': {
      if (prev !== undefined) return prev;
      const init: { readonly theta0?: number } =
        episode.theta0 === undefined ? {} : { theta0: episode.theta0 };
      return freshState(episode.key, episode.at, init);
    }
    case 'sweep': {
      if (prev === undefined) return undefined;
      switch (episode.action) {
        case 'quarantine':
          return overrideStatus(prev, 'quarantined').state;
        case 'retire':
        case 'archive':
          return overrideStatus(prev, 'retired').state;
        case 'restore':
          return overrideStatus(prev, 'restore').state;
        case 'purge':
          return undefined;
        default:
          return assertNever(episode.action, 'sweep action');
      }
    }
    default:
      return assertNever(episode, 'episode type');
  }
}

/** Rebuild every entity state from a log, in seq order. Deterministic. */
export function foldLog(episodes: readonly Episode[]): EntityState[] {
  const ordered = [...episodes].sort((a, b) => a.seq - b.seq);
  const byKey = new Map<string, EntityState>();
  for (const episode of ordered) {
    const key = entityKeyString(episode.key);
    const next = foldEpisode(byKey.get(key), episode);
    if (next === undefined) byKey.delete(key);
    else byKey.set(key, next);
  }
  return [...byKey.values()].sort((a, b) =>
    entityKeyString(a.key) < entityKeyString(b.key) ? -1 : 1,
  );
}
