import {
  type Decision,
  type DecisionCase,
  freshCaseEma,
  isHumanAuthor,
  validateDecision,
} from './decision.ts';
import { type EntityDefinition, validateEntityDefinition } from './definition.ts';
import type { Anchor } from './durability.ts';
import { emaStep } from './ema.ts';
import { type EntityKey, type EntityState, freshState } from './entity.ts';
import { assertNever, InvalidArgumentError, PermissionDeniedError } from './errors.ts';
import {
  applySignal,
  type GuardReport,
  mapEvidence,
  type Override,
  overrideStatus,
  reportGuard,
  type SignalApplication,
  stampLifecycle,
} from './fold.ts';
import { KindRegistry, type KindSpec } from './kinds.ts';
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
  /**
   * Ties this signal to one decision-tree branch (medha-arj.3): its evidence/EMA accrues into
   * that `DecisionCase` via `foldDecisionTree`, isolated from `EntityState.evidence`. Absent (the
   * default) behaves exactly as before — fully backward compatible.
   */
  readonly caseId?: string | undefined;
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
  /** Whether this proposal was promoted by Medha's promotion policy. */
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

/**
 * A host-authored definition for the entity (medha-arj): title/tags/rationale. Never evidential —
 * `foldEpisode` treats this as a no-op, so a definition can never change `EntityState`. Read with
 * `foldDefinitions`, a separate fold entirely.
 */
export interface DefineEpisode extends BaseEpisode {
  readonly type: 'define';
  readonly definition: EntityDefinition;
}

/**
 * Grows or edits one branch of the entity's decision tree (medha-arj.2): non-evidential, like
 * `define` — `foldEpisode` treats it as a no-op, and it is read instead by `foldDecisionTree`.
 * `caseId` names the branch: pass a fresh one from `newDecisionCaseId` to create a branch, or an
 * existing one to edit it (latest-write-wins by seq).
 */
export interface DecisionEpisode extends BaseEpisode {
  readonly type: 'decision';
  readonly caseId: string;
  readonly parentId?: string | undefined;
  readonly condition: string;
  readonly decision: Decision;
}

export type Episode =
  | SignalEpisode
  | GuardEpisode
  | OverrideEpisode
  | ProposalEpisode
  | SweepEpisode
  | BaselineEpisode
  | RetractEpisode
  | DefineEpisode
  | DecisionEpisode;

/** An episode the host submits: everything but the store-assigned `seq`. */
export type EpisodeInput =
  | Omit<SignalEpisode, 'seq'>
  | Omit<GuardEpisode, 'seq'>
  | Omit<OverrideEpisode, 'seq'>
  | Omit<ProposalEpisode, 'seq'>
  | Omit<SweepEpisode, 'seq'>
  | Omit<BaselineEpisode, 'seq'>
  | Omit<RetractEpisode, 'seq'>
  | Omit<DefineEpisode, 'seq'>
  | Omit<DecisionEpisode, 'seq'>;

/** Deterministic map key for an entity. The separator is NUL (illegal in ids). */
export function entityKeyString(key: EntityKey): string {
  return `${key.namespace}\u0000${key.kind}\u0000${key.id}`;
}

/** A registries-backed validation context for episodes entering the log. */
export interface EpisodeValidation {
  readonly kinds: KindRegistry;
  readonly signals: SignalRegistry;
  /**
   * How many episodes the target log holds, when the caller knows. A `retract` is only meaningful
   * against an episode that exists, and `targetSeq` is a positional index into a log that gets
   * renumbered by compaction, resequencing and merge — so a retraction whose target resolves now
   * can silently come to name a different episode later, or a real one it never named. Passing the
   * length is what lets the check happen; omitting it (the per-episode open-time replay, which has
   * no whole-log view) skips the check rather than guessing.
   */
  readonly logLength?: number;
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
      if (
        input.caseId !== undefined &&
        (typeof input.caseId !== 'string' || input.caseId.trim() === '')
      ) {
        throw new InvalidArgumentError('episode.caseId', 'a non-empty string', input.caseId);
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
      // A retraction that names no episode is not inert: it is an armed pointer into a log that
      // keeps growing, and the moment the log passes targetSeq it masks an unrelated episode.
      if (validation.logLength !== undefined && input.targetSeq >= validation.logLength) {
        throw new InvalidArgumentError(
          'episode.targetSeq',
          `an existing episode sequence (the log holds ${validation.logLength})`,
          input.targetSeq,
        );
      }
      break;
    case 'define':
      validateEntityDefinition(input.definition);
      break;
    case 'decision': {
      if (typeof input.caseId !== 'string' || input.caseId.trim() === '') {
        throw new InvalidArgumentError('episode.caseId', 'a non-empty string', input.caseId);
      }
      if (typeof input.condition !== 'string' || input.condition.trim() === '') {
        throw new InvalidArgumentError('episode.condition', 'a non-empty string', input.condition);
      }
      if (
        input.parentId !== undefined &&
        (typeof input.parentId !== 'string' || input.parentId.trim() === '')
      ) {
        throw new InvalidArgumentError('episode.parentId', 'a non-empty string', input.parentId);
      }
      validateDecision(input.decision);

      const kindSpec = validation.kinds.get(input.key.kind);
      const requireHumanFor = kindSpec?.decisionPolicy?.requireHumanFor;
      if (requireHumanFor !== undefined) {
        const gated =
          requireHumanFor === 'apply'
            ? input.decision.type === 'apply'
            : requireHumanFor.includes(input.decision.type);
        if (gated && !isHumanAuthor(input.author)) {
          throw new PermissionDeniedError(
            `decision:${input.decision.type}`,
            `kind '${input.key.kind}' requires a human-tagged author (author: 'human:<id>') for a '${input.decision.type}' branch`,
            {
              context: {
                kind: input.key.kind,
                decisionType: input.decision.type,
                author: input.author,
              },
            },
          );
        }
      }
      break;
    }
    default:
      assertNever(input, 'episode input type');
  }
}

/**
 * Validate a whole log before it replaces the store's (compaction / restore / sync merge): seqs must
 * be exactly contiguous from 0, every episode must validate, and every retraction must name an
 * episode this log actually holds. Throws the typed error naming the first break.
 */
export function validateLog(episodes: readonly Episode[], validation: EpisodeValidation): void {
  // The whole log is in hand, so retractions can be checked for a resolvable target here — the one
  // place a positional `targetSeq` can be verified. Callers rewriting the log (compaction, resequence,
  // merge) are exactly how one goes stale.
  const withLength: EpisodeValidation = { ...validation, logLength: episodes.length };
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
    validateEpisodeInput(episodeToInput(episode), withLength);
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
    case 'define':
      return { ...input, seq };
    case 'decision':
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

export interface FoldEpisodeOptions {
  readonly kinds?: KindRegistry | undefined;
  readonly kindSpec?: KindSpec | undefined;
}

/**
 * Fold one episode into prior state. `at` is the fold's clock, so the same episode applied at
 * the same timestamp always produces the same state. Returns `undefined` when the episode has
 * no effect on the key (no entity and no `ensure`, or a purge).
 */
/**
 * Spec §9.1. When the kind declares `signalLimits`, a success from an author who is over the
 * limit is *suppressed*: it changes nothing but that author's `suppressed` counter (no evidence,
 * EMA, anchors, recency, or status). Otherwise the author's ledger records the counted success.
 * Pure in (state, episode): replay decides identically.
 */
function applySignalLimits(
  prev: EntityState,
  episode: Extract<Episode, { type: 'signal' }>,
  kindSpec: KindSpec | undefined,
): { readonly suppressed: boolean; readonly state: EntityState } {
  const limits = kindSpec?.signalLimits;
  if (limits === undefined || !episode.spec.countsAsSuccess) {
    return { suppressed: false, state: prev };
  }
  const author = episode.author ?? '';
  const ledger = prev.authors?.[author] ?? {
    lastAt: Number.NEGATIVE_INFINITY,
    counted: 0,
    suppressed: 0,
  };
  const tooSoon =
    limits.minIntervalMs !== undefined && episode.at - ledger.lastAt < limits.minIntervalMs;
  const overCap =
    limits.maxSuccessesPerAuthor !== undefined && ledger.counted >= limits.maxSuccessesPerAuthor;
  if (tooSoon || overCap) {
    const next = { ...ledger, suppressed: ledger.suppressed + 1 };
    return { suppressed: true, state: { ...prev, authors: { ...prev.authors, [author]: next } } };
  }
  const next = { lastAt: episode.at, counted: ledger.counted + 1, suppressed: ledger.suppressed };
  return { suppressed: false, state: { ...prev, authors: { ...prev.authors, [author]: next } } };
}

export function foldEpisode(
  prev: EntityState | undefined,
  episode: Episode,
  options?: FoldEpisodeOptions | KindRegistry,
): EntityState | undefined {
  const kindRegistry = options instanceof KindRegistry ? options : options?.kinds;
  const kindSpec =
    options instanceof KindRegistry
      ? options.get(episode.key.kind)
      : (options?.kindSpec ?? kindRegistry?.get(episode.key.kind));

  switch (episode.type) {
    case 'signal': {
      if (prev === undefined) {
        if (!episode.ensure) return undefined;
        prev = freshState(episode.key, episode.at);
      }
      const limited = applySignalLimits(prev, episode, kindSpec);
      if (limited.suppressed) return limited.state;
      prev = limited.state;
      const applied: SignalApplication =
        episode.anchors === undefined
          ? { spec: episode.spec }
          : { spec: episode.spec, anchors: episode.anchors };
      const base = applySignal(prev, applied, { now: episode.at, kindSpec }).state;
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
      const status = statusFor(withWeight, episode.at, kindSpec);
      return { ...withWeight, status };
    }
    case 'guard': {
      if (prev === undefined) {
        if (!episode.ensure) return undefined;
        prev = freshState(episode.key, episode.at);
      }
      const report: GuardReport =
        episode.kind === undefined ? { ok: episode.ok } : { ok: episode.ok, kind: episode.kind };
      const base = reportGuard(prev, report, { now: episode.at, kindSpec }).state;
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
      return { ...episode.state, status: statusFor({ ...episode.state }, episode.at, kindSpec) };
    }
    case 'retract':
      return prev;
    case 'define':
      // Non-evidential by design (medha-arj.1): a definition never changes EntityState.
      return prev;
    case 'decision':
      // Non-evidential by design (medha-arj.2): growing/editing a branch never changes
      // EntityState. A tagged signal episode still folds into EntityState exactly as it would
      // without a caseId — foldDecisionTree separately captures it for the branch.
      return prev;
    default:
      return assertNever(episode, 'episode type');
  }
}

/**
 * Fold `define` episodes into the latest definition per entity, entirely separate from
 * `foldEpisode`'s trust fold (medha-arj.1). Latest-write-wins by seq order; every other episode
 * type is ignored.
 */
export function foldDefinitions(episodes: readonly Episode[]): Map<string, EntityDefinition> {
  const ordered = [...episodes].sort((a, b) => a.seq - b.seq);
  const byKey = new Map<string, EntityDefinition>();
  for (const episode of ordered) {
    if (episode.type !== 'define') continue;
    byKey.set(entityKeyString(episode.key), episode.definition);
  }
  return byKey;
}

const CASE_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** FNV-1a over a string, folded into 32 bits — used only to salt `newDecisionCaseId`. */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A fresh decision-case id (medha-arj.2): `<entity-id>-dec-<5-char-alnum>`.
 * `entityKeyString(key)` is folded into every character so two hosts minting an id for two
 * *different* entities never collide even if their `random` happens to draw the same sequence
 * (e.g. both reseed from a shared clock); `random` supplies the entropy so the same entity's ids
 * don't collide across repeated calls. Defaults to `Math.random` — pass a seeded RNG for
 * determinism in tests.
 */
export function newDecisionCaseId(key: EntityKey, random: () => number = Math.random): string {
  const salt = fnv1a32(entityKeyString(key));
  let suffix = '';
  for (let i = 0; i < 5; i++) {
    const draw = Math.floor(random() * 0x100000000) >>> 0;
    const mixed = (draw ^ ((salt + i * 0x9e3779b9) >>> 0)) >>> 0;
    suffix += CASE_ID_ALPHABET[mixed % CASE_ID_ALPHABET.length];
  }
  return `${key.id}-dec-${suffix}`;
}

/**
 * Build the decision-case forest for one entity key from the log (medha-arj.2), entirely separate
 * from `foldEpisode`'s trust fold: `decision` episodes create or edit a branch (latest-write-wins
 * per `caseId` by seq), and a `signal` episode carrying a matching `caseId` (medha-arj.3) rolls its
 * evidence/EMA into that branch alone — it also still folds into `EntityState` exactly as it would
 * without a `caseId` (see `foldEpisode`'s `'signal'` case), so a branch's trust is additional
 * information, not a replacement for the entity's aggregate.
 */
export function foldDecisionTree(
  episodes: readonly Episode[],
  key: EntityKey,
  kindSpec?: KindSpec,
): DecisionCase[] {
  const target = entityKeyString(key);
  const ordered = [...episodes].sort((a, b) => a.seq - b.seq);
  const byId = new Map<string, DecisionCase>();
  for (const episode of ordered) {
    if (entityKeyString(episode.key) !== target) continue;
    if (episode.type === 'decision') {
      const prevCase = byId.get(episode.caseId);
      byId.set(episode.caseId, {
        id: episode.caseId,
        ...(episode.parentId === undefined ? {} : { parentId: episode.parentId }),
        condition: episode.condition,
        decision: episode.decision,
        evidence: prevCase?.evidence ?? { k: 0, n: 0, contextRejects: 0 },
        ema: prevCase?.ema ?? freshCaseEma(episode.at),
      });
      continue;
    }
    if (episode.type === 'signal' && episode.caseId !== undefined) {
      const prevCase = byId.get(episode.caseId);
      // A signal can only tag an existing branch; one naming an unknown case is silently ignored
      // here (it still folds into EntityState as usual) rather than fabricating a branch with no
      // condition/decision of its own.
      if (prevCase === undefined) continue;
      byId.set(episode.caseId, {
        ...prevCase,
        evidence: mapEvidence(prevCase.evidence, episode.spec, kindSpec),
        ema: {
          mu: emaStep(prevCase.ema.mu, episode.spec.value),
          theta0: prevCase.ema.theta0,
          updatedAt: episode.at,
        },
      });
    }
  }
  return [...byId.values()];
}

/**
 * Rebuild every entity state from a log, in seq order. Deterministic.
 *
 * `alsoRetracted` masks extra seqs as if a retraction naming them were present, for callers folding
 * a *slice* of a log whose retractions live outside it (compaction folds the aged prefix, but a
 * later retraction can still name an episode inside that prefix). It changes nothing about how a
 * retract episode is read — a retract masks its target and nothing else.
 */
export function foldLog(
  episodes: readonly Episode[],
  options?: FoldEpisodeOptions | KindRegistry,
  alsoRetracted?: Iterable<number>,
): EntityState[] {
  const ordered = [...episodes].sort((a, b) => a.seq - b.seq);
  const retracted = new Set<number>();
  for (const ep of ordered) {
    if (ep.type === 'retract') {
      retracted.add(ep.targetSeq);
    }
  }
  for (const seq of alsoRetracted ?? []) retracted.add(seq);
  const byKey = new Map<string, EntityState>();
  for (const episode of ordered) {
    if (retracted.has(episode.seq)) continue;
    const key = entityKeyString(episode.key);
    const next = foldEpisode(byKey.get(key), episode, options);
    if (next === undefined) byKey.delete(key);
    else byKey.set(key, next);
  }
  return [...byKey.values()].sort((a, b) =>
    entityKeyString(a.key) < entityKeyString(b.key) ? -1 : 1,
  );
}
