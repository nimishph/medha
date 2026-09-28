export type { Decision } from './decision-type.ts';

import type { Decision } from './decision-type.ts';
import type { EmaState, EntityState, Evidence, LifecycleStatus } from './entity.ts';
import { InvalidArgumentError } from './errors.ts';
import type { GuardState } from './guard.ts';
import type { KindSpec } from './kinds.ts';
import { DEFAULT_THETA0 } from './thresholds.ts';
import { statusFor, type TrustResult, trustOf } from './trust.ts';

/**
 * Per-entity decision trees, trust spec §11a.2/§11a.3: each branch is a condition -> decision
 * (apply/ignore/probability), growing incrementally from usage, with its own Wilson evidence
 * separate from the entity's aggregate trust.
 */

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

/** A `DecisionCase` plus the live status/trust it scores to — what a host renders (medha-arj.6). */
export interface ScoredDecisionCase extends DecisionCase {
  readonly status: LifecycleStatus;
  readonly trust: number;
}

/** Score every case in a forest at once, in tree order. */
export function scoreDecisionTree(
  tree: readonly DecisionCase[],
  now: number,
  kindSpec?: KindSpec,
): ScoredDecisionCase[] {
  return tree.map((kase) => ({
    ...kase,
    status: caseStatus(kase, now, kindSpec),
    trust: caseTrust(kase, now, kindSpec).trust,
  }));
}

/**
 * The canonical form used to decide whether two conditions are the same branch. Conditions are
 * free text, so "duplicate" has to be pinned down or `--condition "in Legacy"` and
 * `--condition "In  Legacy"` grow two branches that read identically and split the evidence.
 */
export function normalizeCondition(condition: string): string {
  return condition.trim().replace(/\s+/gu, ' ').toLowerCase();
}

/** One `decision` write, as the engine hands it to {@link validateDecisionTreeEdit}. */
export interface DecisionTreeEdit {
  /** The branch being created or edited. */
  readonly caseId: string;
  readonly condition: string;
  /** Explicitly re-parent here. Omitted on an edit means "keep the branch where it is". */
  readonly parentId?: string | undefined;
  /** Explicitly move this branch to the top level. Mutually exclusive with `parentId`. */
  readonly detach?: boolean | undefined;
}

/**
 * Structural checks for one `decision` write, run against the entity's *current* folded tree.
 *
 * Four failure modes this exists to close, each of which used to corrupt a tree silently:
 *
 * - **Orphaning.** An edit that names no `parentId` used to clear it, so editing a branch's
 *   probability silently promoted it to the top level. `parentId` is now "change it, don't touch
 *   it", with `detach` as the only way to move a branch to the root.
 * - **Unknown parents.** `--parent nope-123` used to be accepted and quietly created a root-level
 *   branch, so the caller believed it had built a subtree over a tree that didn't exist. A parent
 *   must name a branch this entity already has.
 * - **Duplicate conditions.** The same condition twice used to create two branches, splitting that
 *   condition's evidence across two trust scores that then both read low forever.
 * - **Typo'd case ids.** `--case-id nope-123` used to mint a *new* branch with that literal id, so
 *   a mistyped edit left the intended branch untouched and the tree quietly grew a stray leaf.
 *
 * Duplicates are scoped to a parent: "in Legacy" once under each of two different roots is two
 * genuinely different branches.
 *
 * `mode` is the caller's intent, because a `caseId` is meaningful in two ways. Omitting the id
 * mints a fresh branch ('create'); supplying one asks to revise that branch ('edit'). Under 'edit'
 * the id must already be in the tree — otherwise a typo does not fail, it *mints a branch called
 * `nope`*, and the caller walks away believing it revised a decision that it actually created.
 */
export function validateDecisionTreeEdit(
  tree: readonly DecisionCase[],
  edit: DecisionTreeEdit,
  mode: 'create' | 'edit' = 'create',
): void {
  const byId = new Map(tree.map((kase) => [kase.id, kase]));

  if (mode === 'edit' && !byId.has(edit.caseId)) {
    const known = [...byId.keys()].sort();
    throw new InvalidArgumentError(
      'decision.caseId',
      known.length === 0
        ? 'not supplied: this entity has no decision branches to edit'
        : `an existing decision case id of this entity (has: ${known.join(', ')})`,
      edit.caseId,
    );
  }

  if (edit.detach === true && edit.parentId !== undefined) {
    throw new InvalidArgumentError(
      'decision.detach',
      'not combined with a parentId (detach means "move to the top level")',
      { detach: true, parentId: edit.parentId },
    );
  }

  // Absent parentId on an edit inherits; only an explicit detach clears it.
  const parentId =
    edit.detach === true ? undefined : (edit.parentId ?? byId.get(edit.caseId)?.parentId);

  if (parentId !== undefined) {
    if (parentId === edit.caseId) {
      throw new InvalidArgumentError('decision.parentId', 'a branch other than itself', parentId);
    }
    if (!byId.has(parentId)) {
      const known = [...byId.keys()].sort();
      throw new InvalidArgumentError(
        'decision.parentId',
        known.length === 0
          ? 'a decision case id (this entity has no decision branches yet)'
          : `an existing decision case id of this entity (has: ${known.join(', ')})`,
        parentId,
      );
    }
    // A parent that already sits under this branch would close a loop, and every renderer that
    // walks parent->children would then walk forever.
    for (let cursor: string | undefined = parentId; cursor !== undefined; ) {
      if (cursor === edit.caseId) {
        throw new InvalidArgumentError(
          'decision.parentId',
          'a branch that is not a descendant of this branch',
          parentId,
        );
      }
      cursor = byId.get(cursor)?.parentId;
    }
  }

  const normalized = normalizeCondition(edit.condition);
  const duplicate = tree.find(
    (kase) =>
      kase.id !== edit.caseId &&
      kase.parentId === parentId &&
      normalizeCondition(kase.condition) === normalized,
  );
  if (duplicate !== undefined) {
    throw new InvalidArgumentError(
      'decision.condition',
      `a condition no sibling of this branch already uses (sibling ${duplicate.id} uses it)`,
      edit.condition,
    );
  }
}
