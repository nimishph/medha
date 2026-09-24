import type { Anchor } from './durability.ts';
import { weekEpoch } from './durability.ts';
import { emaStep } from './ema.ts';
import type { EntityState, LifecycleStatus, Override } from './entity.ts';
import { InvalidArgumentError } from './errors.ts';
import type { GuardState } from './guard.ts';
import type { KindSpec } from './kinds.ts';
import { round6 } from './rounding.ts';
import type { SignalSpec } from './signals.ts';
import { statusFor } from './trust.ts';

/**
 * The fold: applying an observed, resolved signal (or a guard report) to an entity state while
 * staying purely functional. The write plane persists episodes and calls these; they never touch
 * a store. Identical inputs always give identical state — determinism is structural, not best-effort.
 */

export interface FoldContext {
  /** Wall-clock `now` — the only time sage may observe. */
  readonly now: number;
  readonly kindSpec?: KindSpec | undefined;
}

export interface SignalApplication {
  readonly spec: SignalSpec;
  /** Anchor values observed at this use; the engine may attach the calendar-week fallback. */
  readonly anchors?: readonly Anchor[];
}

export interface FoldResult {
  readonly state: EntityState;
  readonly status: LifecycleStatus;
}

function mapEvidence(
  state: EntityState,
  spec: SignalSpec,
  kindSpec?: KindSpec,
): EntityState['evidence'] {
  if (kindSpec?.evidenceWeighting === 'signal-value') {
    const trialWeight = spec.countsAsTrial ? Math.abs(spec.value) : 0;
    const successWeight = spec.countsAsSuccess ? Math.max(0, spec.value) : 0;
    const k = round6(state.evidence.k + successWeight);
    const n = round6(state.evidence.n + trialWeight);
    const contextRejects =
      spec.name === 'REJECT_CONTEXT'
        ? state.evidence.contextRejects + 1
        : state.evidence.contextRejects;
    return { k, n, contextRejects };
  }
  const k = spec.countsAsSuccess ? state.evidence.k + 1 : state.evidence.k;
  const n = spec.countsAsTrial ? state.evidence.n + 1 : state.evidence.n;
  const contextRejects =
    spec.name === 'REJECT_CONTEXT'
      ? state.evidence.contextRejects + 1
      : state.evidence.contextRejects;
  return { k, n, contextRejects };
}

function mapAnchors(
  state: EntityState,
  applied: SignalApplication,
  now: number,
): readonly Anchor[] {
  if (!applied.spec.countsAsSuccess) return state.anchors;
  // With no host anchor on a successful use, the calendar-week epoch is recorded so durability
  // degrades gracefully instead of the entity appearing immortal (spec §5.4 fallback).
  const incoming =
    applied.anchors === undefined || applied.anchors.length === 0
      ? [weekAnchor(now)]
      : applied.anchors;
  const seen = new Set(state.anchors.map((a) => `${a.kind}\u0000${a.value}`));
  const kept = [...state.anchors];
  for (const anchor of incoming) {
    const key = `${anchor.kind}\u0000${anchor.value}`;
    if (!seen.has(key)) {
      seen.add(key);
      kept.push(anchor);
    }
  }
  return kept;
}

/**
 * Record a signal. SKIP never increments n or k (Invariant III): it only damps the EMA.
 * REJECT_CONTEXT increments no trial counters — it is context rejection, not failure.
 */
export function applySignal(
  state: EntityState,
  applied: SignalApplication,
  context: FoldContext,
): FoldResult {
  const next: EntityState = {
    ...state,
    evidence: mapEvidence(state, applied.spec, context.kindSpec),
    ema: {
      mu: emaStep(state.ema.mu, applied.spec.value),
      theta0: state.ema.theta0,
      updatedAt: context.now,
    },
    anchors: mapAnchors(state, applied, context.now),
    lastSignalAt: applied.spec.name === 'SKIP' ? state.lastSignalAt : context.now,
  };
  const status = statusFor(next, context.now, context.kindSpec);
  return { state: { ...next, status }, status };
}

/** The calendar-week fallback anchor for a successful use with no host anchor. */
export function weekAnchor(now: number): Anchor {
  return { kind: 'week', value: String(weekEpoch(now)) };
}

/** A guard report the host made after running its own verification. */
export interface GuardReport {
  readonly ok: boolean;
  /** The name of the guard that ran; defaults to the entity's current guard kind. */
  readonly kind?: string;
}

export function reportGuard(
  state: EntityState,
  report: GuardReport,
  context: FoldContext,
): FoldResult {
  const nextGuard: GuardState = {
    kind: report.kind ?? state.guard.kind,
    lastOk: report.ok,
    lastOkAt: context.now,
  };
  const next: EntityState = { ...state, guard: nextGuard };
  const status = statusFor(next, context.now, context.kindSpec);
  return { state: { ...next, status }, status };
}

/** A lifecycle override from the host (retire/quarantine/restore). */
export type { Override } from './entity.ts';

export function overrideStatus(state: EntityState, override: Override): FoldResult {
  let status: LifecycleStatus;
  let activeOverride: Override | null;
  switch (override) {
    case 'retired':
      status = 'retired';
      activeOverride = 'retired';
      break;
    case 'quarantined':
      status = 'quarantined';
      activeOverride = 'quarantined';
      break;
    case 'restore':
      status = 'probation';
      activeOverride = null;
      break;
    default:
      throw new InvalidArgumentError('override', "'retired' | 'quarantined' | 'restore'", override);
  }
  return { state: { ...state, status, override: activeOverride }, status };
}

/**
 * Stamp the lifecycle clock the maintenance plane reads (`retiredAt` / `restoredAt`). The fold
 * emits the stamp whenever a lifecycle episode lands, so the §8 retention and stale rules are a
 * pure function of the log — and the clock survives compaction, because a baseline reproduces the
 * folded state it carries.
 *
 * A second retirement (e.g. a sweep `archive` of an already-retired entity) keeps the original
 * clock so retention is never reset by re-stating what the fold already produced.
 */
export function stampLifecycle(
  state: EntityState,
  override: Override,
  at: number,
  before: EntityState,
): EntityState {
  switch (override) {
    case 'retired':
      if (before.status === 'retired' && before.retiredAt !== null) return state;
      return { ...state, retiredAt: at, restoredAt: null };
    case 'quarantined':
      return state;
    case 'restore':
      return { ...state, retiredAt: null, restoredAt: at };
    default:
      throw new InvalidArgumentError('override', "'retired' | 'quarantined' | 'restore'", override);
  }
}
