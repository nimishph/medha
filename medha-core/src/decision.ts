import type { EmaState, EntityState, Evidence, LifecycleStatus } from './entity.ts';
import { InvalidArgumentError } from './errors.ts';
import type { GuardState } from './guard.ts';
import type { KindSpec } from './kinds.ts';
import { DEFAULT_THETA0 } from './thresholds.ts';
import { statusFor, type TrustResult, trustOf } from './trust.ts';

/**
 * Per-entity decision trees (spec medha-arj): each branch is a condition -> decision
 * (apply/ignore/probability), growing incrementally from usage, with its own Wilson evidence
 * separate from the entity's aggregate trust.
 */

export type Decision =
  | { readonly type: 'apply' }
  | { readonly type: 'ignore' }
  | { readonly type: 'probability'; readonly value: number };

export interface DecisionCase {
  /** `<entity-id>-dec-<5-char-alnum>`, salted by entityKeyString so concurrent hosts don't collide. */
  readonly id: string;
  readonly parentId?: string | undefined;
  readonly condition: string;
  readonly decision: Decision;
  /** This branch's own Wilson evidence, isolated from the entity's aggregate (medha-arj.3). */
  readonly evidence: Evidence;
  /** This branch's own EMA, accrued only from signal episodes tagged with this case's id. */
  readonly ema: EmaState;
}

/** Validate a `Decision`'s shape before it enters the log. */
export function validateDecision(decision: Decision): void {
  if (typeof decision !== 'object' || decision === null) {
    throw new InvalidArgumentError('decision', 'a Decision object', decision);
  }
  switch (decision.type) {
    case 'apply':
    case 'ignore':
      return;
    case 'probability':
      if (
        typeof decision.value !== 'number' ||
        !Number.isFinite(decision.value) ||
        decision.value < 0 ||
        decision.value > 1
      ) {
        throw new InvalidArgumentError(
          'decision.value',
          'a finite number in [0,1]',
          decision.value,
        );
      }
      return;
    default:
      throw new InvalidArgumentError(
        'decision.type',
        "'apply' | 'ignore' | 'probability'",
        (decision as { type: unknown }).type,
      );
  }
}

/**
 * Convention (medha-arj.4): default-deny. An author counts as a verified human only when
 * explicitly tagged `human:<id>`; every other author — including an anonymous episode — fails a
 * human-gated check, so a `decisionPolicy.requireHumanFor` gate can't be silently bypassed by
 * omitting `author`.
 */
export function isHumanAuthor(author: string | undefined): boolean {
  return typeof author === 'string' && author.startsWith('human:');
}

/**
 * A branch has no guard or anchors of its own — it is scored on its Wilson evidence and EMA alone,
 * always "passed" so unguarded's trust ceiling (Invariant IV) never applies to it. This lets a
 * branch reach `trusted` purely from its own signal history, per the epic: "a branch can be
 * trusted while its parent/siblings are not."
 */
const BRANCH_GUARD: GuardState = { kind: 'branch', lastOk: true, lastOkAt: null };

/** The synthetic per-branch state `caseTrust`/`caseStatus` score, built from a `DecisionCase`. */
function branchState(kase: DecisionCase, kindSpec?: KindSpec): EntityState {
  return {
    key: { namespace: '', kind: kindSpec?.name ?? '', id: kase.id },
    evidence: kase.evidence,
    ema: kase.ema,
    guard: { ...BRANCH_GUARD, lastOkAt: kase.ema.updatedAt },
    anchors: [],
    status: 'probation',
    override: null,
    retiredAt: null,
    restoredAt: null,
    updater: 'ema',
    createdAt: kase.ema.updatedAt,
    lastSignalAt: kase.evidence.n > 0 ? kase.ema.updatedAt : null,
  };
}

/** A fresh branch's EMA: prior `theta0`, no evidence yet — mirrors `freshState`'s EMA seed. */
export function freshCaseEma(at: number, theta0: number = DEFAULT_THETA0): EmaState {
  return { mu: theta0, theta0, updatedAt: at };
}

/** This branch's own trust score, isolated from the parent entity's aggregate. */
export function caseTrust(kase: DecisionCase, now: number, kindSpec?: KindSpec): TrustResult {
  return trustOf(branchState(kase, kindSpec), now, kindSpec);
}

/** This branch's own lifecycle status, isolated from the parent entity's aggregate. */
export function caseStatus(kase: DecisionCase, now: number, kindSpec?: KindSpec): LifecycleStatus {
  return statusFor(branchState(kase, kindSpec), now, kindSpec);
}
