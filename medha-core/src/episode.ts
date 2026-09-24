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
  stampLifecycle,
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
  /** Provenance of the write: agent, user, or tool identifier that authored this episode. */
  readonly author?: string | undefined;
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
  /** Free-form note or rationale explaining the guard outcome. */
  readonly note?: string | undefined;
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
  readonly theta0?: number | undefined;
  readonly description?: string | undefined;
  /** Evidence references supporting this proposal (digest IDs, run refs, etc.). */
  readonly evidenceRefs?: readonly string[] | undefined;
  /** Optional anchor observed at the time of proposal. */
  readonly anchor?: Anchor | undefined;
  /** Whether this proposal was promoted by Sage's promotion policy. */
  readonly promoted?: boolean | undefined;
  /** Reason associated with the promotion decision. */
  readonly promotionReason?: string | undefined;
  /** Free-form note or rationale for the proposal. */
  readonly note?: string | undefined;
}

export type SweepAction = 'quarantine' | 'retire' | 'restore' | 'archive' | 'purge';

export interface SweepEpisode extends BaseEpisode {
  readonly type: 'sweep';
  readonly action: SweepAction;
  readonly reason: string;
}

/**
 * A compaction checkpoint (§8): the folded entity state as of the last episode of the compacted
 * prefix. Compaction replaces an entity's pre-cutoff episodes with one baseline that reproduces the
 * same fold, so the log shrinks without the state ever changing (fold-equivalence is structural).
 */
export interface BaselineEpisode extends BaseEpisode {
  readonly type: 'baseline';
  /** The folded state as of `at`; its `key` must equal the episode's key. */
  readonly state: EntityState;
}

export interface RetractEpisode extends BaseEpisode {
  readonly type: 'retract';
  /** The sequence number of the episode being retracted. */
  readonly targetSeq: number;
  readonly reason: string;
}

export type Episode =
  | SignalEpisode
  | GuardEpisode
  | OverrideEpisode
  | ProposalEpisode
  | SweepEpisode
  | BaselineEpisode
  | RetractEpisode;

/** An episode the host submits: everything but the store-assigned `seq`. */
export type EpisodeInput =
  | Omit<SignalEpisode, 'seq'>
  | Omit<GuardEpisode, 'seq'>
  | Omit<OverrideEpisode, 'seq'>
  | Omit<ProposalEpisode, 'seq'>
  | Omit<SweepEpisode, 'seq'>
  | Omit<BaselineEpisode, 'seq'>
  | Omit<RetractEpisode, 'seq'>;

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
      if (
        input.note !== undefined &&
        (typeof input.note !== 'string' || input.note.trim() === '')
      ) {
        throw new InvalidArgumentError('episode.note', 'a non-empty string', input.note);
      }
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
      if (input.description !== undefined && typeof input.description !== 'string') {
        throw new InvalidArgumentError('episode.description', 'a string', input.description);
      }
      if (
        input.note !== undefined &&
        (typeof input.note !== 'string' || input.note.trim() === '')
      ) {
        throw new InvalidArgumentError('episode.note', 'a non-empty string', input.note);
      }
      if (input.evidenceRefs !== undefined) {
        if (!Array.isArray(input.evidenceRefs)) {
          throw new InvalidArgumentError(
            'episode.evidenceRefs',
            'an array of strings',
            input.evidenceRefs,
          );
        }
        for (const ref of input.evidenceRefs) {
          if (typeof ref !== 'string' || ref.trim() === '') {
            throw new InvalidArgumentError('episode.evidenceRefs[]', 'a non-empty string', ref);
          }
        }
      }
      if (input.anchor !== undefined) {
        if (typeof input.anchor.kind !== 'string' || input.anchor.kind === '') {
          throw new InvalidArgumentError(
            'episode.anchor.kind',
            'a non-empty string',
            input.anchor.kind,
          );
        }
        if (typeof input.anchor.value !== 'string' || input.anchor.value === '') {
          throw new InvalidArgumentError(
            'episode.anchor.value',
            'a non-empty string',
            input.anchor.value,
          );
        }
      }
      break;
    case 'sweep':
      if (typeof input.reason !== 'string' || input.reason.trim() === '') {
        throw new InvalidArgumentError('episode.reason', 'a non-empty string', input.reason);
      }
      break;
    case 'baseline':
      // The checkpoint must describe the key it carries, or the fold would be ambiguous.
      if (entityKeyString(input.state.key) !== entityKeyString(input.key)) {
        throw new InvalidArgumentError(
          'episode.state.key',
          `to equal the episode key (${entityKeyString(input.key)})`,
          input.state.key,
        );
      }
      if (typeof input.state.evidence?.n !== 'number' || input.state.evidence.n < 0) {
        throw new InvalidArgumentError(
          'episode.state.evidence',
          'a well-formed Evidence',
          input.state.evidence,
        );
      }
      break;
    case 'retract':
      if (
        typeof input.targetSeq !== 'number' ||
        !Number.isInteger(input.targetSeq) ||
        input.targetSeq < 0
      ) {
        throw new InvalidArgumentError(
          'episode.targetSeq',
          'a non-negative integer',
          input.targetSeq,
        );
      }
      if (typeof input.reason !== 'string' || input.reason.trim() === '') {
        throw new InvalidArgumentError('episode.reason', 'a non-empty string', input.reason);
      }
      break;
    default:
      assertNever(input, 'episode input type');
  }
}

/**
 * Validate a whole log before it replaces the store's (compaction / restore): seqs must be exactly
 * contiguous from 0 and every episode must validate. Throws the typed error naming the first break.
 */
export function validateLog(episodes: readonly Episode[], validation: EpisodeValidation): void {
  for (let i = 0; i < episodes.length; i++) {
    const episode = episodes[i];
    if (episode === undefined) {
      throw new InvalidArgumentError('episodes', `a dense log; missing seq ${i}`, i);
    }
    if (episode.seq !== i) {
      throw new InvalidArgumentError(
        'episodes[].seq',
        `contiguous from 0 (expected ${i})`,
        episode.seq,
      );
    }
    validateEpisodeInput(episodeToInput(episode), validation);
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
    case 'baseline':
      return { ...input, seq };
    case 'retract':
      return { ...input, seq };
    default:
      return assertNever(input, 'episode input type');
  }
}

/** Strip the store-assigned `seq`, yielding the episode as it entered the log (for validation). */
export function episodeToInput(episode: Episode): EpisodeInput {
  const { seq: _seq, ...rest } = episode;
  return rest as EpisodeInput;
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
      const noteToKeep = episode.note ?? base.lastNote;
      if (episode.weight === undefined) {
        return noteToKeep !== undefined ? { ...base, lastNote: noteToKeep } : base;
      }
      // Self-describing weight-updater result: the episode carries the mu the configured strategy
      // produced, and the fold re-derives status from it — determinism, no registry in the way.
      const withWeight: EntityState = {
        ...base,
        ema: { mu: episode.weight, theta0: prev.ema.theta0, updatedAt: episode.at },
        ...(noteToKeep !== undefined ? { lastNote: noteToKeep } : {}),
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
      const base = reportGuard(prev, report, { now: episode.at }).state;
      const noteToKeep = episode.note ?? base.lastNote;
      return noteToKeep !== undefined ? { ...base, lastNote: noteToKeep } : base;
    }
    case 'override': {
      if (prev === undefined) return undefined;
      const base = stampLifecycle(
        overrideStatus(prev, episode.override).state,
        episode.override,
        episode.at,
        prev,
      );
      return { ...base, lastNote: episode.reason };
    }
    case 'proposal': {
      if (prev !== undefined) return prev;
      const init: { readonly theta0?: number; readonly anchor?: Anchor } = {
        ...(episode.theta0 === undefined ? {} : { theta0: episode.theta0 }),
        ...(episode.anchor === undefined ? {} : { anchor: episode.anchor }),
      };
      const fresh = freshState(episode.key, episode.at, init);
      const noteToKeep = episode.note ?? episode.description;
      return noteToKeep !== undefined ? { ...fresh, lastNote: noteToKeep } : fresh;
    }
    case 'sweep': {
      if (prev === undefined) return undefined;
      switch (episode.action) {
        case 'quarantine':
          return stampLifecycle(
            overrideStatus(prev, 'quarantined').state,
            'quarantined',
            episode.at,
            prev,
          );
        case 'retire':
        case 'archive':
          return stampLifecycle(overrideStatus(prev, 'retired').state, 'retired', episode.at, prev);
        case 'restore':
          return stampLifecycle(overrideStatus(prev, 'restore').state, 'restore', episode.at, prev);
        case 'purge':
          return undefined;
        default:
          return assertNever(episode.action, 'sweep action');
      }
    }
    case 'baseline': {
      // The checkpoint reproduces the folded prefix: apply as-is, re-derive the status at its
      // clock so recency/trust stay live — determinism is structural, not cached.
      return { ...episode.state, status: statusFor({ ...episode.state }, episode.at) };
    }
    case 'retract':
      return prev;
    default:
      return assertNever(episode, 'episode type');
  }
}

/** Rebuild every entity state from a log, in seq order. Deterministic. */
export function foldLog(episodes: readonly Episode[]): EntityState[] {
  const ordered = [...episodes].sort((a, b) => a.seq - b.seq);
  const retracted = new Set<number>();
  for (const ep of ordered) {
    if (ep.type === 'retract') {
      retracted.add(ep.targetSeq);
    }
  }
  const byKey = new Map<string, EntityState>();
  for (const episode of ordered) {
    if (retracted.has(episode.seq)) continue;
    const key = entityKeyString(episode.key);
    const next = foldEpisode(byKey.get(key), episode);
    if (next === undefined) byKey.delete(key);
    else byKey.set(key, next);
  }
  return [...byKey.values()].sort((a, b) =>
    entityKeyString(a.key) < entityKeyString(b.key) ? -1 : 1,
  );
}
