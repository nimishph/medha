import {
  ACTIVE_THRESHOLD,
  buildHint,
  type Context,
  DAY_MS,
  type EntityKey,
  type EntityState,
  type Episode,
  type EvidentialHint,
  evaluateGates,
  foldEpisode,
  freshState,
  type Gate,
  type GuardState,
  InvalidArgumentError,
  isUnguarded,
  type KindSpec,
  type LifecycleStatus,
  MIN_USES_FOR_RETIRED,
  MIN_USES_FOR_TRUSTED,
  RECENCY_FLOOR,
  RECENCY_HALF_LIFE_DAYS,
  RETIRED_TRUST_THRESHOLD,
  round6,
  SignalRegistry,
  type SignalSpec,
  TRUSTED_THRESHOLD,
  UNGUARDED_TRUST_CEILING,
} from '@cntxt-labs/medha-core';
import type { OpenedHome } from './open.ts';

/**
 * Read-only model of one entity for the dashboard's Inspect tab: the hint plus everything the page
 * needs to explain it in plain language (guard state, effective thresholds, the signals the store
 * accepts) and to replay hypothetical events (`simulatePath`). Nothing here ever writes.
 */

export type GuardCondition = 'none' | 'unverified' | 'passed' | 'failed';

export interface InspectThresholds {
  readonly active: number;
  readonly trusted: number;
  readonly minUsesForTrusted: number;
  readonly minUsesForRetired: number;
  readonly retiredTrustThreshold: number;
  readonly unguardedCeiling: number;
  readonly recencyHalfLifeDays: number;
  readonly recencyFloor: number;
}

export interface InspectDetail {
  readonly key: EntityKey;
  readonly known: boolean;
  readonly asOf: number;
  readonly hint: EvidentialHint;
  readonly gates: readonly Gate[];
  readonly guard: {
    readonly kind: string;
    readonly condition: GuardCondition;
    readonly lastOk: boolean | null;
    readonly lastOkAt: number | null;
  };
  readonly override: EntityState['override'];
  readonly lastSignalAt: number | null;
  readonly thresholds: InspectThresholds;
  readonly signals: readonly SignalSpec[];
  readonly episodes: readonly Episode[];
}

export type SimulationStep =
  | { readonly type: 'signal'; readonly signal: string }
  | { readonly type: 'guard'; readonly ok: boolean; readonly kind?: string | undefined }
  | { readonly type: 'advance'; readonly days: number };

export interface SimulationFrame {
  readonly label: string;
  readonly at: number;
  readonly hint: EvidentialHint;
  readonly guard: InspectDetail['guard'];
  readonly deltaTrust: number;
  readonly statusChanged: boolean;
  readonly previousStatus: LifecycleStatus;
}

export interface SimulationPath {
  readonly key: EntityKey;
  readonly frames: readonly SimulationFrame[];
}

/** Upper bounds that keep a hand-crafted request from pinning the server on a long replay. */
const MAX_STEPS = 50;
const MAX_ADVANCE_DAYS = 3650;

export function guardCondition(guard: GuardState): GuardCondition {
  if (isUnguarded(guard)) return 'none';
  if (guard.lastOk === true) return 'passed';
  if (guard.lastOk === false) return 'failed';
  return 'unverified';
}

function guardView(guard: GuardState): InspectDetail['guard'] {
  return {
    kind: isUnguarded(guard) ? 'none' : guard.kind,
    condition: guardCondition(guard),
    lastOk: guard.lastOk,
    lastOkAt: guard.lastOkAt,
  };
}

function thresholdsFor(spec: KindSpec | undefined): InspectThresholds {
  const t = spec?.thresholds;
  return {
    active: t?.active ?? ACTIVE_THRESHOLD,
    trusted: t?.trusted ?? TRUSTED_THRESHOLD,
    minUsesForTrusted: t?.minUsesForTrusted ?? MIN_USES_FOR_TRUSTED,
    minUsesForRetired: t?.minUsesForRetired ?? MIN_USES_FOR_RETIRED,
    retiredTrustThreshold: t?.retiredTrustThreshold ?? RETIRED_TRUST_THRESHOLD,
    unguardedCeiling: t?.unguardedCeiling ?? UNGUARDED_TRUST_CEILING,
    recencyHalfLifeDays: spec?.recency?.halfLifeDays ?? RECENCY_HALF_LIFE_DAYS,
    recencyFloor: spec?.recency?.floor ?? RECENCY_FLOOR,
  };
}

function signalRegistry(opened: OpenedHome): SignalRegistry {
  return new SignalRegistry(opened.store.registries.signalSpecs);
}

function listSignals(opened: OpenedHome): readonly SignalSpec[] {
  // The registry resolves names/aliases; the page needs the specs behind the canonical names plus
  // whatever the host registered, so ask the store's own list when it has one.
  const seeded = opened.store.registries.signalSpecs;
  const registry = signalRegistry(opened);
  const names = new Set<string>(['APPLY', 'REJECT_RULE', 'SKIP', 'REJECT_CONTEXT']);
  for (const spec of seeded ?? []) names.add(spec.name);
  return [...names].map((name) => registry.resolve(name));
}

function requireKey(key: EntityKey): void {
  if (typeof key.id !== 'string' || key.id.trim() === '') {
    throw new InvalidArgumentError('id', 'a non-empty string', key.id);
  }
}

export async function inspectEntity(
  opened: OpenedHome,
  key: EntityKey,
  context: Context,
): Promise<InspectDetail> {
  requireKey(key);
  const spec = opened.adminEngine.getKindSpec(key.kind);
  const stored = await opened.store.get(key);
  const state = stored ?? freshState(key, context.now);
  const hint = buildHint(state, context.now, spec);
  const episodes = (await opened.store.episodes()).filter(
    (ep) => ep.key.id === key.id && ep.key.kind === key.kind && ep.key.namespace === key.namespace,
  );
  return {
    key,
    known: stored !== undefined,
    asOf: context.now,
    hint,
    gates: evaluateGates(state, hint.trustScore, spec),
    guard: guardView(state.guard),
    override: state.override,
    lastSignalAt: state.lastSignalAt,
    thresholds: thresholdsFor(spec),
    signals: listSignals(opened),
    episodes,
  };
}

function describeStep(step: SimulationStep): string {
  switch (step.type) {
    case 'signal':
      return step.signal;
    case 'guard':
      return `guard ${step.ok ? 'passes' : 'fails'}${step.kind ? ` (${step.kind})` : ''}`;
    case 'advance':
      return `wait ${step.days} day${step.days === 1 ? '' : 's'}`;
  }
}

/**
 * Replay hypothetical events against the stored state, in memory, and report the hint after each
 * one. Uses the kernel's own fold so every frame is exactly what the real log would produce.
 */
export async function simulatePath(
  opened: OpenedHome,
  key: EntityKey,
  steps: readonly SimulationStep[],
  context: Context,
): Promise<SimulationPath> {
  requireKey(key);
  if (!Array.isArray(steps)) {
    throw new InvalidArgumentError('steps', 'an array', steps);
  }
  if (steps.length > MAX_STEPS) {
    throw new InvalidArgumentError('steps', `at most ${MAX_STEPS} steps`, steps.length);
  }
  const spec = opened.adminEngine.getKindSpec(key.kind);
  const registry = signalRegistry(opened);
  let state: EntityState = (await opened.store.get(key)) ?? freshState(key, context.now);
  let at = context.now;
  let hint = buildHint(state, at, spec);
  const frames: SimulationFrame[] = [
    {
      label: 'Now',
      at,
      hint,
      guard: guardView(state.guard),
      deltaTrust: 0,
      statusChanged: false,
      previousStatus: hint.status,
    },
  ];

  for (const step of steps) {
    let episode: Episode | undefined;
    if (step.type === 'signal') {
      episode = {
        type: 'signal',
        seq: 0,
        key,
        at,
        spec: registry.resolve(step.signal),
        ensure: true,
      };
    } else if (step.type === 'guard') {
      episode = {
        type: 'guard',
        seq: 0,
        key,
        at,
        ok: step.ok,
        ensure: true,
        ...(step.kind === undefined || step.kind === '' ? {} : { kind: step.kind }),
      };
    } else if (step.type === 'advance') {
      if (!Number.isFinite(step.days) || step.days < 0 || step.days > MAX_ADVANCE_DAYS) {
        throw new InvalidArgumentError(
          'days',
          `a number between 0 and ${MAX_ADVANCE_DAYS}`,
          step.days,
        );
      }
      at += step.days * DAY_MS;
    } else {
      throw new InvalidArgumentError('step.type', "'signal' | 'guard' | 'advance'", step);
    }

    if (episode !== undefined) {
      state = foldEpisode(state, episode, { kindSpec: spec }) ?? state;
    }
    const next = buildHint(state, at, spec);
    frames.push({
      label: describeStep(step),
      at,
      hint: next,
      guard: guardView(state.guard),
      deltaTrust: round6(next.trustScore - hint.trustScore),
      statusChanged: next.status !== hint.status,
      previousStatus: hint.status,
    });
    hint = next;
  }
  return { key, frames };
}
