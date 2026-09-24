import type { EntityKey } from './entity.ts';
import { entityKeyString } from './episode.ts';
import { InvalidArgumentError } from './errors.ts';
import type { EvidentialHint } from './hint.ts';
import { mulberry32, pickWeighted } from './rng.ts';
import { round6 } from './rounding.ts';
import { wilsonWidth } from './wilson.ts';

export const DEFAULT_EXPLORATION_RATIO = 0.15;

/** A candidate entity presented to the evidential token budget packer. */
export interface PackCandidate<T = unknown> {
  readonly key: EntityKey;
  readonly hint: EvidentialHint;
  /** Estimated cost in tokens or bytes (must be > 0). */
  readonly cost: number;
  /** If true, this item is packed first if budget allows, bypassing knapsack. */
  readonly mandatory?: boolean | undefined;
  /** Optional application-specific payload (e.g. prompt text, rule markdown, tool definition). */
  readonly payload?: T | undefined;
}

/** Configuration policy governing evidential context packing. */
export interface PackPolicy {
  /** Maximum token or byte budget (safe non-negative integer). */
  readonly budget: number;
  /**
   * Proportion of available budget reserved for exploring probation entities (default: 0.15 = 15%).
   * Unused exploration budget cascades back into merit packing.
   */
  readonly explorationRatio?: number | undefined;
  /** Seed for deterministic probation exploration sampling. */
  readonly seed?: number | undefined;
  /** Minimum trust score required for merit candidates (default: 0). */
  readonly minTrust?: number | undefined;
  /** Allow quarantined entities into candidate pool (default: false). */
  readonly allowQuarantined?: boolean | undefined;
  /** Allow retired entities into candidate pool (default: false). */
  readonly allowRetired?: boolean | undefined;
}

/** An entity selected into the packed context. */
export interface PackedEntity<T = unknown> {
  readonly key: EntityKey;
  readonly hint: EvidentialHint;
  readonly cost: number;
  readonly admittedBy: 'mandatory' | 'probation' | 'merit';
  /** Evidential density: trustScore / cost */
  readonly density: number;
  /** Wilson uncertainty interval width for the candidate. */
  readonly uncertainty: number;
  readonly payload?: T | undefined;
}

/** Structured summary report of the packing operation. */
export interface PackOutcome<T = unknown> {
  readonly selected: readonly PackedEntity<T>[];
  readonly rejected: readonly PackCandidate<T>[];
  readonly budget: number;
  readonly totalCost: number;
  readonly remainingBudget: number;
  readonly utilization: number;
  readonly mandatoryCount: number;
  readonly probationCount: number;
  readonly meritCount: number;
}

function compareKey(a: EntityKey, b: EntityKey): number {
  const sa = entityKeyString(a);
  const sb = entityKeyString(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function uncertaintyOf(hint: EvidentialHint): number {
  return wilsonWidth(hint.evidence.successes, hint.evidence.totalTrials);
}

/**
 * Pure evidential token-budget packer:
 *
 * 1. Filters out quarantined and retired entities (unless explicitly permitted).
 * 2. Mandatory Stage: Pins mandatory candidates up to available budget.
 * 3. Exploration Stage: Allocates up to `explorationRatio * remainingBudget` for probation
 *    entities sampled via seeded Wilson-interval uncertainty (least-known tried soonest).
 * 4. Merit Stage: Packs remaining budget with highest density (trustScore / cost) greedy
 *    knapsack with lookahead, absorbing any unused exploration budget.
 */
export function packEntities<T = unknown>(
  candidates: readonly PackCandidate<T>[],
  policy: PackPolicy,
): PackOutcome<T> {
  if (!Number.isSafeInteger(policy.budget) || policy.budget < 0) {
    throw new InvalidArgumentError('policy.budget', 'a non-negative integer', policy.budget);
  }
  const explorationRatio = policy.explorationRatio ?? DEFAULT_EXPLORATION_RATIO;
  if (!Number.isFinite(explorationRatio) || explorationRatio < 0 || explorationRatio > 1) {
    throw new InvalidArgumentError(
      'policy.explorationRatio',
      'a finite number in [0, 1]',
      policy.explorationRatio,
    );
  }
  const minTrust = policy.minTrust ?? 0;
  if (!Number.isFinite(minTrust)) {
    throw new InvalidArgumentError('policy.minTrust', 'a finite number', policy.minTrust);
  }

  for (const c of candidates) {
    if (!Number.isFinite(c.cost) || c.cost <= 0) {
      throw new InvalidArgumentError('candidate.cost', 'a positive finite number', c.cost);
    }
  }

  if (policy.budget === 0 || candidates.length === 0) {
    return {
      selected: [],
      rejected: [...candidates],
      budget: policy.budget,
      totalCost: 0,
      remainingBudget: policy.budget,
      utilization: 0,
      mandatoryCount: 0,
      probationCount: 0,
      meritCount: 0,
    };
  }

  const allowQuarantined = policy.allowQuarantined ?? false;
  const allowRetired = policy.allowRetired ?? false;

  // Filter candidates by lifecycle and trust (mandatory items bypass minTrust)
  const eligible: PackCandidate<T>[] = [];
  const rejected: PackCandidate<T>[] = [];

  for (const c of candidates) {
    const status = c.hint.status;
    if (status === 'quarantined' && !allowQuarantined) {
      rejected.push(c);
      continue;
    }
    if (status === 'retired' && !allowRetired) {
      rejected.push(c);
      continue;
    }
    if (c.mandatory !== true && c.hint.trustScore < minTrust) {
      rejected.push(c);
      continue;
    }
    eligible.push(c);
  }

  const selected: PackedEntity<T>[] = [];
  let remainingBudget = policy.budget;

  // Stage 1: Mandatory
  const mandatoryCandidates: PackCandidate<T>[] = [];
  const standardCandidates: PackCandidate<T>[] = [];

  for (const c of eligible) {
    if (c.mandatory === true) {
      mandatoryCandidates.push(c);
    } else {
      standardCandidates.push(c);
    }
  }

  // Sort mandatory deterministically by trust desc, then key
  mandatoryCandidates.sort(
    (a, b) => b.hint.trustScore - a.hint.trustScore || compareKey(a.key, b.key),
  );

  let mandatoryCount = 0;
  for (const c of mandatoryCandidates) {
    if (c.cost <= remainingBudget) {
      remainingBudget -= c.cost;
      mandatoryCount++;
      selected.push({
        key: c.key,
        hint: c.hint,
        cost: c.cost,
        admittedBy: 'mandatory',
        density: round6(c.hint.trustScore / c.cost),
        uncertainty: uncertaintyOf(c.hint),
        payload: c.payload,
      });
    } else {
      rejected.push(c);
    }
  }

  // Stage 2: Exploration / Probation
  let probationCount = 0;
  const probationCandidates = standardCandidates.filter((c) => c.hint.status === 'probation');

  let explorationBudget = Math.floor(remainingBudget * explorationRatio);
  const remainingStandardPool = new Set<PackCandidate<T>>(standardCandidates);

  if (probationCandidates.length > 0 && explorationBudget > 0 && policy.seed !== undefined) {
    const rng = mulberry32(policy.seed);
    const sampled = pickWeighted(
      probationCandidates,
      (c) => uncertaintyOf(c.hint),
      rng,
      probationCandidates.length,
    );

    for (const c of sampled) {
      if (c.cost <= explorationBudget && c.cost <= remainingBudget) {
        explorationBudget -= c.cost;
        remainingBudget -= c.cost;
        probationCount++;
        remainingStandardPool.delete(c);
        selected.push({
          key: c.key,
          hint: c.hint,
          cost: c.cost,
          admittedBy: 'probation',
          density: round6(c.hint.trustScore / c.cost),
          uncertainty: uncertaintyOf(c.hint),
          payload: c.payload,
        });
      }
    }
  }

  // Stage 3: Merit Packing (remaining pool sorted by evidential density desc)
  const meritPool = Array.from(remainingStandardPool);
  meritPool.sort((a, b) => {
    const densityA = a.hint.trustScore / a.cost;
    const densityB = b.hint.trustScore / b.cost;
    return densityB - densityA || b.hint.trustScore - a.hint.trustScore || compareKey(a.key, b.key);
  });

  let meritCount = 0;
  for (const c of meritPool) {
    if (c.cost <= remainingBudget) {
      remainingBudget -= c.cost;
      meritCount++;
      selected.push({
        key: c.key,
        hint: c.hint,
        cost: c.cost,
        admittedBy: 'merit',
        density: round6(c.hint.trustScore / c.cost),
        uncertainty: uncertaintyOf(c.hint),
        payload: c.payload,
      });
    } else {
      rejected.push(c);
    }
  }

  const totalCost = policy.budget - remainingBudget;
  const utilization = round6(policy.budget > 0 ? totalCost / policy.budget : 0);

  return {
    selected,
    rejected,
    budget: policy.budget,
    totalCost,
    remainingBudget,
    utilization,
    mandatoryCount,
    probationCount,
    meritCount,
  };
}
