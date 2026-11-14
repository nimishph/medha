import type { ContextTargets } from './definition.ts';
import type { EntityKey } from './entity.ts';
import { entityKeyString } from './episode.ts';
import { InvalidArgumentError } from './errors.ts';
import type { EvidentialHint } from './hint.ts';
import { mulberry32, pickWeighted } from './rng.ts';
import { round6 } from './rounding.ts';
import { wilsonWidth } from './wilson.ts';

export const DEFAULT_EXPLORATION_RATIO = 0.15;

export interface ContextFilter {
  /** File paths or globs in the active agent task. */
  readonly files?: readonly string[] | undefined;
  /** Active programming languages (e.g. ['typescript', 'rust']). */
  readonly languages?: readonly string[] | undefined;
  /** Active user query, task prompt, or keywords. */
  readonly query?: string | undefined;
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '.*')
    .replace(/(?<!\.)\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`, 'i');
}

/** Check if candidate context targets match the query/active context (medha-c8z.1). */
export function matchesContextTargets(
  targets: ContextTargets | undefined,
  filter: ContextFilter | undefined,
): boolean {
  if (filter === undefined || targets === undefined) return true;
  const hasFiles = (targets.files?.length ?? 0) > 0;
  const hasLanguages = (targets.languages?.length ?? 0) > 0;
  const hasKeywords = (targets.keywords?.length ?? 0) > 0;
  if (!hasFiles && !hasLanguages && !hasKeywords) return true;

  if (hasFiles && filter.files && filter.files.length > 0) {
    for (const pattern of targets.files ?? []) {
      const rx = pattern.includes('*') ? globToRegex(pattern) : undefined;
      for (const file of filter.files) {
        if (
          file === pattern ||
          file.endsWith(pattern) ||
          pattern.endsWith(file) ||
          file.includes(pattern) ||
          rx?.test(file) === true
        ) {
          return true;
        }
      }
    }
  }

  if (hasLanguages && filter.languages && filter.languages.length > 0) {
    const targetLangs = (targets.languages ?? []).map((l) => l.toLowerCase());
    for (const lang of filter.languages) {
      if (targetLangs.includes(lang.toLowerCase())) {
        return true;
      }
    }
  }

  if (hasKeywords && filter.query) {
    const q = filter.query.toLowerCase();
    for (const kw of targets.keywords ?? []) {
      if (q.includes(kw.toLowerCase())) {
        return true;
      }
    }
  }

  return false;
}

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
  /** Optional context targets for selective context matching (medha-c8z.1). */
  readonly contextTargets?: ContextTargets | undefined;
}

/** High-confidence negative evidence pitfall warning (medha-c8z.4). */
export interface Pitfall {
  readonly key: EntityKey;
  readonly status: 'quarantined' | 'retired';
  readonly trials: number;
  readonly successes: number;
  readonly failingGuard?: string | undefined;
  readonly lastNote?: string | undefined;
  readonly reason: string;
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
  /** Filter candidates by active files/languages/query keywords (medha-c8z.1). */
  readonly contextFilter?: ContextFilter | undefined;
  /** Include high-confidence negative-evidence pitfalls radar (medha-c8z.4). */
  readonly includePitfalls?: boolean | undefined;
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
  /** High-confidence pitfalls radar if requested (medha-c8z.4). */
  readonly pitfalls?: readonly Pitfall[] | undefined;
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
 * Identify high-confidence negative evidence (medha-c8z.4):
 * Retired and quarantined entities with n >= minFailures (default 5) or failing guards.
 */
export function findPitfalls(
  candidatesOrHints: readonly (PackCandidate | EvidentialHint)[],
  options: { readonly minFailures?: number } = {},
): readonly Pitfall[] {
  const minFailures = options.minFailures ?? 5;
  const pitfalls: Pitfall[] = [];
  for (const item of candidatesOrHints) {
    const hint = 'hint' in item ? item.hint : item;
    if (hint.status !== 'retired' && hint.status !== 'quarantined') continue;
    const trials = hint.evidence.totalTrials;
    const guardFailing = hint.components.guard === 0;
    if (trials >= minFailures || guardFailing) {
      const reason =
        hint.status === 'retired'
          ? `Retired after ${trials} trials with low trust (${hint.evidence.successes} successes)`
          : `Quarantined (${guardFailing ? 'guard failed' : 'downward weight drift'})`;
      pitfalls.push({
        key: hint.key,
        status: hint.status,
        trials,
        successes: hint.evidence.successes,
        failingGuard: guardFailing ? 'guard' : undefined,
        lastNote: hint.lastNote,
        reason,
      });
    }
  }
  return pitfalls;
}

/**
 * Pure evidential token-budget packer:
 *
 * 1. Filters out quarantined and retired entities (unless explicitly permitted).
 * 2. Matches active context targets (files, languages, keywords).
 * 3. Mandatory Stage: Pins mandatory candidates up to available budget.
 * 4. Exploration Stage: Allocates up to `explorationRatio * remainingBudget` for probation
 *    entities sampled via seeded Wilson-interval uncertainty (least-known tried soonest).
 * 5. Merit Stage: Packs remaining budget with highest density (trustScore / cost) greedy
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

  const pitfalls = policy.includePitfalls ? findPitfalls(candidates) : undefined;

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
      ...(pitfalls !== undefined ? { pitfalls } : {}),
    };
  }

  const allowQuarantined = policy.allowQuarantined ?? false;
  const allowRetired = policy.allowRetired ?? false;

  // Filter candidates by context targets, lifecycle, and trust (mandatory items bypass minTrust)
  const eligible: PackCandidate<T>[] = [];
  const rejected: PackCandidate<T>[] = [];

  for (const c of candidates) {
    // Context targets matching (medha-c8z.1)
    if (
      c.contextTargets !== undefined &&
      !matchesContextTargets(c.contextTargets, policy.contextFilter)
    ) {
      rejected.push(c);
      continue;
    }

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
    ...(pitfalls !== undefined ? { pitfalls } : {}),
  };
}
