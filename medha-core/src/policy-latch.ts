import type { Decision, DecisionCase, ScoredDecisionCase } from './decision.ts';
import { isHumanAuthor, scoreDecisionTree } from './decision.ts';
import type { EntityKey, EntityState, LifecycleStatus } from './entity.ts';
import type { KindSpec } from './kinds.ts';
import { trustOf } from './trust.ts';

/**
 * PolicyLatch input for checking regulated agent compliance before high-risk mutations execute (medha-534).
 */
export interface PolicyLatchInput {
  readonly key: EntityKey;
  /** Context environment string, condition query, or attributes map. */
  readonly context?: string | Record<string, unknown> | undefined;
  /** Author proposing the action (e.g. "agent:claude-3-5-sonnet" or "human:alice"). */
  readonly author?: string | undefined;
  /** The specific action name or mutation proposed (e.g. "deploy", "drop_table", "modify_config"). */
  readonly action?: string | undefined;
  /** Minimum trust score required to execute (optional, default uses kind thresholds). */
  readonly minTrust?: number | undefined;
}

export type PolicyLatchRecommendation = 'proceed' | 'escalate_to_human' | 'block' | 'skip';

export type PolicyLatchReason =
  | 'approved'
  | 'status_latched'
  | 'require_human_gate'
  | 'branch_untrusted'
  | 'entity_untrusted'
  | 'decision_ignore'
  | 'no_matching_branch'
  | 'entity_not_found';

export interface PolicyLatchStatusSummary {
  readonly status: 'retired' | 'quarantined';
  readonly seq?: number | undefined;
  readonly cause?: string | undefined;
  readonly liftedBy?: readonly ('restore' | 'retract')[] | undefined;
}

export interface PolicyLatchOutcome {
  readonly allowed: boolean;
  readonly latched: boolean;
  readonly requiresHuman: boolean;
  readonly recommendation: PolicyLatchRecommendation;
  readonly reason: PolicyLatchReason;
  readonly explanation: string;
  readonly trust: number;
  readonly status: LifecycleStatus;
  readonly matchedCase?: ScoredDecisionCase | undefined;
  readonly decision?: Decision | undefined;
  readonly statusLatch?: PolicyLatchStatusSummary | undefined;
  readonly escalationInstructions?: string | undefined;
}

/**
 * Match a condition expression against a context string or key-value attributes.
 */
export function matchCondition(
  condition: string,
  context?: string | Record<string, unknown> | undefined,
): boolean {
  const normCond = condition.trim();
  if (
    normCond === '' ||
    normCond === '*' ||
    normCond.toLowerCase() === 'always' ||
    normCond.toLowerCase() === 'true'
  ) {
    return true;
  }
  if (context === undefined || context === null) {
    return normCond.toLowerCase() === 'default' || normCond.toLowerCase() === 'none';
  }
  if (typeof context === 'string') {
    const normCtx = context.trim().toLowerCase();
    const lowerCond = normCond.toLowerCase();
    return normCtx === lowerCond || normCtx.includes(lowerCond) || lowerCond.includes(normCtx);
  }
  if (typeof context === 'object') {
    const clauses = normCond.split(/\s+(?:&&|and)\s+/iu);
    return clauses.every((clause) => matchSingleClause(clause.trim(), context));
  }
  return false;
}

function matchSingleClause(clause: string, ctx: Record<string, unknown>): boolean {
  if (clause === '' || clause === '*' || clause.toLowerCase() === 'true') return true;

  // Key-value equality: key == 'val' or key == "val"
  const eqMatch = clause.match(/^([a-zA-Z0-9_.-]+)\s*(?:==|=)\s*(['"]?)(.*?)\2$/u);
  if (eqMatch && eqMatch[1] !== undefined && eqMatch[3] !== undefined) {
    const key = eqMatch[1];
    const val = eqMatch[3];
    const actual = ctx[key];
    if (actual === undefined) return false;
    return String(actual).toLowerCase() === val.toLowerCase();
  }

  // Key-value inequality: key != 'val'
  const neMatch = clause.match(/^([a-zA-Z0-9_.-]+)\s*!=\s*(['"]?)(.*?)\2$/u);
  if (neMatch && neMatch[1] !== undefined && neMatch[3] !== undefined) {
    const key = neMatch[1];
    const val = neMatch[3];
    const actual = ctx[key];
    if (actual === undefined) return true;
    return String(actual).toLowerCase() !== val.toLowerCase();
  }

  // Set membership: key in [a, b, c]
  const inMatch = clause.match(/^([a-zA-Z0-9_.-]+)\s+in\s+\[(.*?)\]$/u);
  if (inMatch && inMatch[1] !== undefined && inMatch[2] !== undefined) {
    const key = inMatch[1];
    const listStr = inMatch[2];
    const actual = ctx[key];
    if (actual === undefined) return false;
    const items = listStr.split(',').map((s) =>
      s
        .trim()
        .replace(/^['"]|['"]$/gu, '')
        .toLowerCase(),
    );
    return items.includes(String(actual).toLowerCase());
  }

  // Boolean flag / keyword presence
  const cleanClause = clause.replace(/^['"]|['"]$/gu, '').toLowerCase();
  if (cleanClause in ctx) {
    const v = ctx[cleanClause];
    return v === true || v === 'true' || v === 1;
  }

  // Search across keys and stringified values
  for (const [k, v] of Object.entries(ctx)) {
    if (k.toLowerCase() === cleanClause) return true;
    if (String(v).toLowerCase() === cleanClause) return true;
  }

  return false;
}

/**
 * Evaluate regulated policy compliance, decision trees, and requireHumanFor gating (medha-534).
 */
export function evaluatePolicyLatch(
  state: EntityState | null,
  decisionTree: readonly DecisionCase[],
  kindSpec: KindSpec | undefined,
  input: PolicyLatchInput,
  now: number,
  statusLatch?: PolicyLatchStatusSummary | undefined,
): PolicyLatchOutcome {
  // 1. Entity presence
  if (state === null) {
    return {
      allowed: false,
      latched: false,
      requiresHuman: false,
      recommendation: 'block',
      reason: 'entity_not_found',
      explanation: `Entity '${input.key.kind}:${input.key.id}' does not exist in store.`,
      trust: 0,
      status: 'probation',
    };
  }

  // 2. Entity StatusLatch (retirement or quarantine)
  if (state.status === 'retired' || state.status === 'quarantined' || statusLatch !== undefined) {
    const status = state.status;
    return {
      allowed: false,
      latched: true,
      requiresHuman: true,
      recommendation: 'escalate_to_human',
      reason: 'status_latched',
      explanation: `Entity '${input.key.id}' is locked in status latch '${status}'. High-risk mutations are blocked until reinstated by a human.`,
      trust: state.evidence.k / Math.max(1, state.evidence.n),
      status,
      statusLatch,
      escalationInstructions: `Run 'medha reinstate --id ${input.key.id} --reason "<justification>"' with a human author to lift the latch.`,
    };
  }

  // 3. Decision Tree evaluation
  if (decisionTree.length > 0) {
    const scoredTree = scoreDecisionTree(decisionTree, now, kindSpec);
    let matchedCase: ScoredDecisionCase | undefined;

    for (const kase of scoredTree) {
      if (matchCondition(kase.condition, input.context)) {
        matchedCase = kase;
        break;
      }
    }

    if (matchedCase !== undefined) {
      // 3a. Branch status latch
      if (matchedCase.status === 'retired' || matchedCase.status === 'quarantined') {
        return {
          allowed: false,
          latched: true,
          requiresHuman: true,
          recommendation: 'escalate_to_human',
          reason: 'branch_untrusted',
          explanation: `Decision branch '${matchedCase.id}' (${matchedCase.condition}) has latched status '${matchedCase.status}'.`,
          trust: matchedCase.trust,
          status: matchedCase.status,
          matchedCase,
          decision: matchedCase.decision,
          escalationInstructions: `Review branch '${matchedCase.id}' and record human review or new evidence.`,
        };
      }

      // 3b. Human Gatekeeper: decisionPolicy.requireHumanFor check
      const reqHuman = kindSpec?.decisionPolicy?.requireHumanFor;
      const isGated =
        reqHuman !== undefined &&
        (reqHuman === 'apply'
          ? matchedCase.decision.type === 'apply'
          : reqHuman.includes(matchedCase.decision.type));

      if (isGated) {
        const human = isHumanAuthor(input.author);
        if (!human) {
          return {
            allowed: false,
            latched: true,
            requiresHuman: true,
            recommendation: 'escalate_to_human',
            reason: 'require_human_gate',
            explanation: `Kind '${kindSpec?.name ?? input.key.kind}' gates '${matchedCase.decision.type}' decisions via requireHumanFor. Author '${input.author ?? 'anonymous'}' is not a verified human.`,
            trust: matchedCase.trust,
            status: matchedCase.status,
            matchedCase,
            decision: matchedCase.decision,
            escalationInstructions: `A human operator must authorize this action (author format: human:<username>).`,
          };
        }
      }

      // 3c. Evaluate decision type & trust
      switch (matchedCase.decision.type) {
        case 'apply': {
          if (input.minTrust !== undefined && matchedCase.trust < input.minTrust) {
            return {
              allowed: false,
              latched: false,
              requiresHuman: false,
              recommendation: 'block',
              reason: 'branch_untrusted',
              explanation: `Decision branch '${matchedCase.id}' trust (${matchedCase.trust.toFixed(3)}) is below required minTrust (${input.minTrust.toFixed(3)}).`,
              trust: matchedCase.trust,
              status: matchedCase.status,
              matchedCase,
              decision: matchedCase.decision,
            };
          }
          return {
            allowed: true,
            latched: false,
            requiresHuman: false,
            recommendation: 'proceed',
            reason: 'approved',
            explanation: `Decision branch '${matchedCase.id}' (${matchedCase.condition}) approves application with trust ${matchedCase.trust.toFixed(3)}.`,
            trust: matchedCase.trust,
            status: matchedCase.status,
            matchedCase,
            decision: matchedCase.decision,
          };
        }
        case 'ignore': {
          return {
            allowed: false,
            latched: false,
            requiresHuman: false,
            recommendation: 'skip',
            reason: 'decision_ignore',
            explanation: `Decision branch '${matchedCase.id}' (${matchedCase.condition}) prescribes ignore for this context.`,
            trust: matchedCase.trust,
            status: matchedCase.status,
            matchedCase,
            decision: matchedCase.decision,
          };
        }
        case 'probability': {
          const prob = matchedCase.decision.value;
          const allowed = prob >= 0.5;
          return {
            allowed,
            latched: false,
            requiresHuman: false,
            recommendation: allowed ? 'proceed' : 'skip',
            reason: allowed ? 'approved' : 'decision_ignore',
            explanation: `Decision branch '${matchedCase.id}' prescribes probability ${prob.toFixed(2)}.`,
            trust: matchedCase.trust,
            status: matchedCase.status,
            matchedCase,
            decision: matchedCase.decision,
          };
        }
      }
    }
  }

  // 4. Default evaluation when no branch matches or no decision tree exists
  const currentTrust = trustOf(state, now, kindSpec).trust;
  const reqHuman = kindSpec?.decisionPolicy?.requireHumanFor;
  const isGated =
    reqHuman !== undefined && (reqHuman === 'apply' ? true : reqHuman.includes('apply'));

  if (isGated && !isHumanAuthor(input.author)) {
    return {
      allowed: false,
      latched: true,
      requiresHuman: true,
      recommendation: 'escalate_to_human',
      reason: 'require_human_gate',
      explanation: `Kind '${kindSpec?.name ?? input.key.kind}' gates applications via requireHumanFor. Author '${input.author ?? 'anonymous'}' is not a verified human.`,
      trust: currentTrust,
      status: state.status,
      escalationInstructions: `A human operator must authorize this action (author format: human:<username>).`,
    };
  }

  if (state.status === 'trusted' || state.status === 'active') {
    if (input.minTrust !== undefined && currentTrust < input.minTrust) {
      return {
        allowed: false,
        latched: false,
        requiresHuman: false,
        recommendation: 'block',
        reason: 'entity_untrusted',
        explanation: `Entity trust (${currentTrust.toFixed(3)}) is below required minTrust (${input.minTrust.toFixed(3)}).`,
        trust: currentTrust,
        status: state.status,
      };
    }
    return {
      allowed: true,
      latched: false,
      requiresHuman: false,
      recommendation: 'proceed',
      reason: 'approved',
      explanation: `Entity '${input.key.id}' is ${state.status} with trust ${currentTrust.toFixed(3)}.`,
      trust: currentTrust,
      status: state.status,
    };
  }

  return {
    allowed: false,
    latched: false,
    requiresHuman: false,
    recommendation: 'block',
    reason: 'entity_untrusted',
    explanation: `Entity '${input.key.id}' is in status '${state.status}' (untrusted).`,
    trust: currentTrust,
    status: state.status,
  };
}
