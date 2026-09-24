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
}

export interface KindRecency {
  readonly halfLifeDays?: number;
  readonly floor?: number;
}

export type EvidenceWeightingMode = 'count' | 'signal-value';

export interface KindSpec {
  readonly name: string;
  readonly description?: string;
  readonly thresholds?: KindThresholds;
  readonly recency?: KindRecency;
  readonly evidenceWeighting?: EvidenceWeightingMode;
}

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

    const { name, thresholds, recency, evidenceWeighting } = nameOrSpec;
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
