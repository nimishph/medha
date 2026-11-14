import type { Decision } from './decision-type.ts';
import { InvalidArgumentError, UnknownKindError } from './errors.ts';

/**
 * Open kinds validated by a registry, library spec §5.2.
 *
 * Built-ins are exactly the three kinds the model names: `rule`, `recipe`, `tool`.
 * Everything else (`locator`, `pitfall`, `constraint`, …) is registered by the host.
 * Unknown kinds fail loud with the full list of registered kinds — a typo is a bug.
 */

export const BUILTIN_KINDS = ['rule', 'recipe', 'tool'] as const;

export interface KindThresholds {
  readonly trusted?: number;
  readonly active?: number;
  readonly unguardedCeiling?: number;
  readonly minUsesForTrusted?: number;
  readonly minUsesForRetired?: number;
  readonly retiredTrustThreshold?: number;
  /**
   * Retirement by trust also needs this many distinct authors among the failed trials (spec §6
   * step 5.1, since 2.0.0). Default 1: no author requirement. Above 1 the fold keeps
   * `rejectingAuthors` for the kind, so one reviewer cannot retire a rule alone.
   */
  readonly minDistinctAuthorsForRetired?: number;
}

/**
 * Opt-in limits on how much one author can raise an entity's trust (spec §9.1). They apply only to
 * signals that can raise trust (`countsAsSuccess`); negative evidence is never throttled.
 */
export interface KindSignalLimits {
  /** A success from the same author within this many ms of their last counted one is suppressed. */
  readonly minIntervalMs?: number;
  /** At most this many counted successes per author per entity; later ones are suppressed. */
  readonly maxSuccessesPerAuthor?: number;
}

export interface KindRecency {
  readonly halfLifeDays?: number;
  readonly floor?: number;
}

export type EvidenceWeightingMode = 'count' | 'signal-value';

/**
 * Governs who may grant a decision-tree branch of a given type, trust spec §11a.4. `'apply'` is
 * shorthand for `['apply']`. Absent means every decision type is agent-editable (code-review
 * governance); listing a type here makes it human-gated (tool-gate governance) — both governance
 * modes ride the same `DecisionEpisode` type.
 */
export interface KindDecisionPolicy {
  readonly requireHumanFor?: readonly Decision['type'][] | 'apply';
}

/**
 * Epistemic signal weighting and role archetypes for multi-agent systems (medha-c8z.3).
 */
export interface KindAgentRoles {
  /** Epistemic signal weighting per agent role (e.g. { reviewer: 1.5, tester: 1.2, coder: 0.8 }). */
  readonly roleWeights?: Readonly<Record<string, number>> | undefined;
}

/**
 * Epistemic multi-agent convergence gates required before status transitions (medha-c8z.3).
 */
export interface KindConvergenceGates {
  /** Minimum number of distinct agent roles required among successes to leave probation for active (default 1). */
  readonly minDistinctRolesForActive?: number | undefined;
  /** Minimum number of distinct agent roles required among successes to reach trusted (default 1). */
  readonly minDistinctRolesForTrusted?: number | undefined;
  /** Specific agent roles that must be represented among observed successes to reach trusted (e.g. ['tester', 'reviewer']). */
  readonly requiredRolesForTrusted?: readonly string[] | undefined;
}

export interface KindSpec {
  readonly name: string;
  readonly description?: string;
  readonly thresholds?: KindThresholds;
  readonly recency?: KindRecency;
  readonly evidenceWeighting?: EvidenceWeightingMode;
  readonly signalLimits?: KindSignalLimits;
  readonly decisionPolicy?: KindDecisionPolicy;
  readonly agentRoles?: KindAgentRoles;
  readonly convergenceGates?: KindConvergenceGates;
}

const DECISION_TYPES = ['apply', 'ignore', 'probability'] as const;

export class KindRegistry {
  private readonly specs = new Map<string, KindSpec>();

  constructor(initial?: readonly (string | KindSpec)[]) {
    for (const b of BUILTIN_KINDS) {
      this.specs.set(b, { name: b });
    }
    for (const item of initial ?? []) {
      this.register(item);
    }
  }

  register(nameOrSpec: string | KindSpec): this {
    if (typeof nameOrSpec === 'string') {
      if (nameOrSpec.trim() === '') {
        throw new InvalidArgumentError('kind name', 'a non-empty string', nameOrSpec);
      }
      if (!this.specs.has(nameOrSpec)) {
        this.specs.set(nameOrSpec, { name: nameOrSpec });
      }
      return this;
    }

    if (typeof nameOrSpec !== 'object' || nameOrSpec === null) {
      throw new InvalidArgumentError('kind spec', 'a KindSpec object or string', nameOrSpec);
    }

    const { name, thresholds, recency, evidenceWeighting, signalLimits, decisionPolicy } =
      nameOrSpec;
    if (typeof name !== 'string' || name.trim() === '') {
      throw new InvalidArgumentError('kind spec.name', 'a non-empty string', name);
    }

    if (thresholds !== undefined) {
      if (typeof thresholds !== 'object' || thresholds === null) {
        throw new InvalidArgumentError('kind spec.thresholds', 'an object', thresholds);
      }
      for (const [key, val] of Object.entries(thresholds)) {
        if (val !== undefined) {
          if (typeof val !== 'number' || Number.isNaN(val)) {
            throw new InvalidArgumentError(`thresholds.${key}`, 'a number', val);
          }
          if (['trusted', 'active', 'unguardedCeiling', 'retiredTrustThreshold'].includes(key)) {
            if (val < 0 || val > 1) {
              throw new InvalidArgumentError(`thresholds.${key}`, 'a number in [0, 1]', val);
            }
          }
          if (['minUsesForTrusted', 'minUsesForRetired'].includes(key)) {
            if (val < 0) {
              throw new InvalidArgumentError(`thresholds.${key}`, 'a non-negative number', val);
            }
          }
          if (key === 'minDistinctAuthorsForRetired' && (!Number.isInteger(val) || val < 1)) {
            throw new InvalidArgumentError(`thresholds.${key}`, 'a positive integer', val);
          }
        }
      }
    }

    if (recency !== undefined) {
      if (typeof recency !== 'object' || recency === null) {
        throw new InvalidArgumentError('kind spec.recency', 'an object', recency);
      }
      if (recency.halfLifeDays !== undefined) {
        if (typeof recency.halfLifeDays !== 'number' || recency.halfLifeDays <= 0) {
          throw new InvalidArgumentError(
            'recency.halfLifeDays',
            'a positive number',
            recency.halfLifeDays,
          );
        }
      }
      if (recency.floor !== undefined) {
        if (typeof recency.floor !== 'number' || recency.floor < 0 || recency.floor > 1) {
          throw new InvalidArgumentError('recency.floor', 'a number in [0, 1]', recency.floor);
        }
      }
    }

    if (evidenceWeighting !== undefined) {
      if (evidenceWeighting !== 'count' && evidenceWeighting !== 'signal-value') {
        throw new InvalidArgumentError(
          'kind spec.evidenceWeighting',
          "'count' | 'signal-value'",
          evidenceWeighting,
        );
      }
    }

    if (signalLimits !== undefined) {
      if (typeof signalLimits !== 'object' || signalLimits === null) {
        throw new InvalidArgumentError('kind spec.signalLimits', 'an object', signalLimits);
      }
      for (const field of ['minIntervalMs', 'maxSuccessesPerAuthor'] as const) {
        const val = signalLimits[field];
        if (val === undefined) continue;
        const ok =
          typeof val === 'number' &&
          Number.isFinite(val) &&
          (field === 'minIntervalMs' ? val >= 0 : Number.isInteger(val) && val >= 1);
        if (!ok) {
          throw new InvalidArgumentError(
            `signalLimits.${field}`,
            field === 'minIntervalMs' ? 'a non-negative number' : 'a positive integer',
            val,
          );
        }
      }
    }

    if (decisionPolicy !== undefined) {
      if (typeof decisionPolicy !== 'object' || decisionPolicy === null) {
        throw new InvalidArgumentError('kind spec.decisionPolicy', 'an object', decisionPolicy);
      }
      const { requireHumanFor } = decisionPolicy;
      if (requireHumanFor !== undefined && requireHumanFor !== 'apply') {
        if (!Array.isArray(requireHumanFor)) {
          throw new InvalidArgumentError(
            'decisionPolicy.requireHumanFor',
            "'apply' or an array of Decision types",
            requireHumanFor,
          );
        }
        for (const type of requireHumanFor) {
          if (!DECISION_TYPES.includes(type)) {
            throw new InvalidArgumentError(
              'decisionPolicy.requireHumanFor[]',
              "'apply' | 'ignore' | 'probability'",
              type,
            );
          }
        }
      }
    }

    if (nameOrSpec.agentRoles !== undefined) {
      if (typeof nameOrSpec.agentRoles !== 'object' || nameOrSpec.agentRoles === null) {
        throw new InvalidArgumentError('kind spec.agentRoles', 'an object', nameOrSpec.agentRoles);
      }
      if (nameOrSpec.agentRoles.roleWeights !== undefined) {
        if (
          typeof nameOrSpec.agentRoles.roleWeights !== 'object' ||
          nameOrSpec.agentRoles.roleWeights === null
        ) {
          throw new InvalidArgumentError(
            'agentRoles.roleWeights',
            'an object',
            nameOrSpec.agentRoles.roleWeights,
          );
        }
        for (const [role, weight] of Object.entries(nameOrSpec.agentRoles.roleWeights)) {
          if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
            throw new InvalidArgumentError(
              `agentRoles.roleWeights.${role}`,
              'a positive number',
              weight,
            );
          }
        }
      }
    }

    if (nameOrSpec.convergenceGates !== undefined) {
      if (typeof nameOrSpec.convergenceGates !== 'object' || nameOrSpec.convergenceGates === null) {
        throw new InvalidArgumentError(
          'kind spec.convergenceGates',
          'an object',
          nameOrSpec.convergenceGates,
        );
      }
      for (const field of ['minDistinctRolesForActive', 'minDistinctRolesForTrusted'] as const) {
        const val = nameOrSpec.convergenceGates[field];
        if (val !== undefined && (!Number.isInteger(val) || val < 1)) {
          throw new InvalidArgumentError(
            `convergenceGates.${field}`,
            'a positive integer >= 1',
            val,
          );
        }
      }
      const reqRoles = nameOrSpec.convergenceGates.requiredRolesForTrusted;
      if (reqRoles !== undefined) {
        if (!Array.isArray(reqRoles)) {
          throw new InvalidArgumentError(
            'convergenceGates.requiredRolesForTrusted',
            'an array of strings',
            reqRoles,
          );
        }
        for (const r of reqRoles) {
          if (typeof r !== 'string' || r.trim() === '') {
            throw new InvalidArgumentError(
              'convergenceGates.requiredRolesForTrusted[]',
              'a non-empty string',
              r,
            );
          }
        }
      }
    }

    const existing = this.specs.get(name);
    this.specs.set(name, existing ? { ...existing, ...nameOrSpec } : nameOrSpec);
    return this;
  }

  has(name: string): boolean {
    return this.specs.has(name);
  }

  get(name: string): KindSpec | undefined {
    return this.specs.get(name);
  }

  get all(): readonly string[] {
    return [...this.specs.keys()];
  }

  get allSpecs(): readonly KindSpec[] {
    return [...this.specs.values()];
  }

  requireKnown(kind: string): void {
    if (!this.specs.has(kind)) {
      throw new UnknownKindError(kind, [...this.specs.keys()]);
    }
  }
}
