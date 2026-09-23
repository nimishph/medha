/**
 * Pluggable weight-updater registry, ported from the legacy Sutra updater architecture
 * (Loom-ujs3.7). The write plane resolves the entity's updater through the registry, so a
 * strategy is a first-class object, not a branch in `record`. The tiers mirror the legacy
 * precedence — **project → user → built-in** — but as in-memory registration rather than
 * filesystem scanning (the library has no notion of project/global directories; hosts register
 * updaters programmatically).
 *
 * Built-ins: `ema` (kernel default), `wilson`, `sliding-window`, `asymmetric-penalty` (alias
 * `asymmetric`). Each mirrors the legacy math but operates on the unified `EntityState` counters.
 * Execution is sandboxed: any failure falls back to EMA and is *reported*, never swallowed.
 */

import type { EmaParams, EntityKey, SignalSpec } from '@cntxt-labs/medha-core';
import {
  emaStep,
  InvalidArgumentError,
  isDrifting,
  type MedhaError,
  round6,
  toMedhaError,
  WILSON_Z,
  wilsonLowerBound,
} from '@cntxt-labs/medha-core';

/**
 * The evidence context a weight-updater sees, over the unified state. Mirrors the legacy
 * `WeightUpdateContext`, but the identity is an `EntityKey` (there is no per-rule id) and the
 * signal is a resolved `SignalSpec` (never a bare string).
 */
export interface WeightUpdateContext {
  readonly key: EntityKey;
  /** `ema.mu` in the entity state. */
  readonly currentWeight: number;
  /** `ema.theta0` — the author baseline the drift is measured against. */
  readonly initialWeight: number;
  readonly signal: SignalSpec;
  /** `evidence.n` — trials so far (this signal not yet applied). */
  readonly sampleCount: number;
  /** `evidence.k` — successes so far. */
  readonly acceptanceCount: number;
  /** `evidence.contextRejects` — REJECT_CONTEXT signals (never trials). */
  readonly contextRejectCount: number;
  /** Equal to `n - k`: trials that were not successes (REJECT_RULE and friends). */
  readonly rejectRuleCount: number;
  /** The entity's EMA state (or any parameters the updater wants to read). */
  readonly parameters: Partial<EmaParams> | Readonly<Record<string, unknown>>;
}

export interface WeightUpdateOutcome {
  readonly newWeight: number;
  readonly isDrifting?: boolean;
  readonly metadata?: Record<string, unknown>;
}

export interface MedhaWeightUpdater {
  readonly name: string;
  computeWeight(ctx: WeightUpdateContext): WeightUpdateOutcome | number;
  detectDrift?(ctx: WeightUpdateContext, newWeight: number): boolean;
}

// ---------------------------------------------------------------------------------------------
// Built-ins (ported from core/fn/weight-updaters/*.ts against the unified counters)
// ---------------------------------------------------------------------------------------------

/** EMA — the kernel default; `emaStep` math, kernel drift semantics. */
export const emaUpdater: MedhaWeightUpdater = {
  name: 'ema',
  computeWeight(ctx: WeightUpdateContext): WeightUpdateOutcome {
    const params = ctx.parameters as Partial<EmaParams>;
    const newWeight = emaStep(ctx.currentWeight, ctx.signal.value, params.alpha);
    return {
      newWeight,
      isDrifting: isDrifting(newWeight, ctx.initialWeight, ctx.sampleCount + 1),
    };
  },
};

/** Wilson lower bound, with a prior-ratio blend until 5 samples stabilise the estimate. */
export const wilsonUpdater: MedhaWeightUpdater = {
  name: 'wilson',
  computeWeight(ctx: WeightUpdateContext): WeightUpdateOutcome {
    const countsAsSuccess = ctx.signal.countsAsTrial && ctx.signal.countsAsSuccess;
    const totalPositive = ctx.acceptanceCount + (countsAsSuccess ? 1 : 0);
    const totalSamples = ctx.sampleCount + 1;

    // Minimum-sample stabilisation: blend the prior with the naive ratio until enough samples.
    if (totalSamples < 5) {
      const naiveRatio = totalPositive / totalSamples;
      return {
        newWeight: round6(0.5 * ctx.initialWeight + 0.5 * naiveRatio),
        isDrifting: false,
        metadata: { blending: 'prior-ratio 50/50 until 5 samples' },
      };
    }

    // Legacy passed 0.95 as the `z` argument — a confidence reading, not a z-value. The port
    // uses the kernel WILSON_Z (1.96), which is what the model §3.1 table calls for.
    const newWeight = wilsonLowerBound(totalPositive, totalSamples, WILSON_Z);
    const delta = Math.abs(newWeight - ctx.initialWeight);
    return {
      newWeight,
      isDrifting: totalSamples >= 10 && delta > 0.3,
      metadata: { totalPositive, totalSamples, confidence: 0.95 },
    };
  },
};

/** Window-bounded step: an APPLY nudges up, a rejection pushes down a bounded per-event step. */
export const slidingWindowUpdater: MedhaWeightUpdater = {
  name: 'sliding-window',
  computeWeight(ctx: WeightUpdateContext): WeightUpdateOutcome {
    const step = 1 / Math.max(10, Math.min(50, ctx.sampleCount + 1));
    const delta =
      ctx.signal.countsAsTrial && ctx.signal.countsAsSuccess
        ? step * (1 - ctx.currentWeight)
        : ctx.signal.name === 'REJECT_CONTEXT'
          ? -step * 0.5 * ctx.currentWeight
          : ctx.signal.countsAsTrial
            ? -step * ctx.currentWeight
            : 0;
    const newWeight = round6(Math.max(0, Math.min(1, ctx.currentWeight + delta)));
    const driftDelta = Math.abs(newWeight - ctx.initialWeight);
    return { newWeight, isDrifting: ctx.sampleCount >= 10 && driftDelta > 0.3 };
  },
};

/** Asymmetric penalty: moderate gain on success (+0.04), harsh penalty on rejection (-0.25). */
export const asymmetricUpdater: MedhaWeightUpdater = {
  name: 'asymmetric-penalty',
  computeWeight(ctx: WeightUpdateContext): WeightUpdateOutcome {
    const delta =
      ctx.signal.countsAsTrial && ctx.signal.countsAsSuccess
        ? 0.04 * (1 - ctx.currentWeight)
        : ctx.signal.name === 'REJECT_CONTEXT'
          ? -0.05 * ctx.currentWeight
          : ctx.signal.countsAsTrial
            ? -0.25 * ctx.currentWeight
            : 0;
    const newWeight = round6(Math.max(0, Math.min(1, ctx.currentWeight + delta)));
    const driftDelta = Math.abs(newWeight - ctx.initialWeight);
    return {
      newWeight,
      isDrifting: ctx.sampleCount >= 5 && driftDelta > 0.25,
      metadata: { strategy: 'asymmetric_penalty' },
    };
  },
};

export const BUILTIN_UPDATERS: Readonly<Record<string, MedhaWeightUpdater>> = {
  ema: emaUpdater,
  wilson: wilsonUpdater,
  'sliding-window': slidingWindowUpdater,
  'asymmetric-penalty': asymmetricUpdater,
  asymmetric: asymmetricUpdater,
};

/** `getBuiltinUpdater` falls back to EMA for unknown names, matching the legacy behaviour. */
export function getBuiltinUpdater(name = 'ema'): MedhaWeightUpdater {
  return BUILTIN_UPDATERS[name.toLowerCase()] ?? emaUpdater;
}

// ---------------------------------------------------------------------------------------------
// 3-tier registry
// ---------------------------------------------------------------------------------------------

export type UpdaterSource = 'builtin' | 'project' | 'user';

export interface UpdaterInfo {
  readonly name: string;
  readonly source: UpdaterSource;
}

export interface UpdaterRegistryOptions {
  /** Updater used when nothing overrides it; default 'ema'. */
  readonly defaultUpdater?: string;
  /** Per-domain routing, e.g. { reviewer: 'wilson' }. Takes precedence over the default. */
  readonly storeOverrides?: Readonly<Record<string, string>>;
  /** Project-tier seed (highest precedence over user/built-in). */
  readonly project?: Readonly<Record<string, MedhaWeightUpdater>>;
  /** User-tier seed (beats built-in, loses to project). */
  readonly user?: Readonly<Record<string, MedhaWeightUpdater>>;
}

/** A compute result, including *reported* fallback: `updaterName` 'ema' + `fallbackFrom`. */
export interface SageComputeResult {
  readonly outcome: WeightUpdateOutcome;
  readonly updaterName: string;
  readonly fallbackFrom?: string;
  /** Present when the registered updater threw and the EMA fallback ran. */
  readonly error?: MedhaError;
}

const DEFAULT_UPDATER = 'ema';

function normalizeOutcome(raw: WeightUpdateOutcome | number): WeightUpdateOutcome {
  const source = typeof raw === 'number' ? { newWeight: raw } : raw;
  if (typeof source.newWeight !== 'number' || !Number.isFinite(source.newWeight)) {
    throw new InvalidArgumentError('updater newWeight', 'a finite number', source.newWeight);
  }
  return {
    newWeight: round6(Math.max(0, Math.min(1, source.newWeight))),
    ...(source.isDrifting === undefined ? {} : { isDrifting: source.isDrifting }),
    ...(source.metadata === undefined ? {} : { metadata: source.metadata }),
  };
}

export class UpdaterRegistry {
  private readonly project = new Map<string, MedhaWeightUpdater>();
  private readonly user = new Map<string, MedhaWeightUpdater>();
  private readonly storeOverrides = new Map<string, string>();
  private defaultUpdaterName: string;

  constructor(options: UpdaterRegistryOptions = {}) {
    this.defaultUpdaterName = options.defaultUpdater ?? DEFAULT_UPDATER;
    for (const [domain, name] of Object.entries(options.storeOverrides ?? {})) {
      this.storeOverrides.set(domain.toLowerCase(), name);
    }
    for (const updater of Object.values(options.project ?? {})) this.register(updater, 'project');
    for (const updater of Object.values(options.user ?? {})) this.register(updater, 'user');
  }

  /** The updater a domain routes to, with the default as the last resort (never throws). */
  resolveForDomain(domain?: string): MedhaWeightUpdater {
    const key = domain?.toLowerCase();
    const override = key === undefined ? undefined : this.storeOverrides.get(key);
    const name = override ?? this.defaultUpdaterName;
    return this.resolve(name) ?? emaUpdater;
  }

  /** Resolve by name across project → user → built-in; `undefined` when it resolves to nothing. */
  resolve(name: string): MedhaWeightUpdater | undefined {
    const key = name.toLowerCase();
    return this.project.get(key) ?? this.user.get(key) ?? BUILTIN_UPDATERS[key];
  }

  has(name: string): boolean {
    return this.resolve(name) !== undefined;
  }

  /** Register an updater at a tier. A name registered at a higher tier shadows lower tiers. */
  register(updater: MedhaWeightUpdater, tier: UpdaterSource): this {
    if (typeof updater.name !== 'string' || updater.name.trim() === '') {
      throw new InvalidArgumentError('updater.name', 'a non-empty string', updater.name);
    }
    if (typeof updater.computeWeight !== 'function') {
      throw new InvalidArgumentError('updater.computeWeight', 'a function', updater.computeWeight);
    }
    (tier === 'project' ? this.project : this.user).set(updater.name.toLowerCase(), updater);
    return this;
  }

  setDefaultUpdater(name: string): this {
    this.defaultUpdaterName = name;
    return this;
  }

  setStoreUpdater(domain: string, updaterName: string): this {
    this.storeOverrides.set(domain.toLowerCase(), updaterName);
    return this;
  }

  /**
   * Sandboxed weight computation. `nameOrDomain` is first tried as a domain override, then as a
   * direct updater name, then the default applies. Any failure inside `computeWeight` falls back
   * to EMA and is reported via `updaterName: 'ema'` + `fallbackFrom` (never silently swallowed).
   */
  computeWeightSafe(ctx: WeightUpdateContext, nameOrDomain?: string): SageComputeResult {
    let name: string;
    if (nameOrDomain === undefined) {
      name = this.defaultUpdaterName;
    } else {
      const key = nameOrDomain.toLowerCase();
      const override = this.storeOverrides.get(key);
      name = (override ?? key).toLowerCase();
    }
    const updater = this.resolve(name) ?? emaUpdater;
    const silentlyFellBack = updater === emaUpdater && name !== DEFAULT_UPDATER;
    try {
      const outcome = normalizeOutcome(updater.computeWeight(ctx));
      return silentlyFellBack
        ? { outcome, updaterName: updater.name, fallbackFrom: name }
        : { outcome, updaterName: updater.name };
    } catch (thrown) {
      const outcome = normalizeOutcome(emaUpdater.computeWeight(ctx));
      return {
        outcome,
        updaterName: DEFAULT_UPDATER,
        fallbackFrom: name,
        error: toMedhaError(thrown, `weight updater '${updater.name}'`),
      };
    }
  }

  /** Every resolvable updater, project and user first (they shadow), built-ins last. */
  listUpdaters(): UpdaterInfo[] {
    const seen = new Set<string>();
    const out: UpdaterInfo[] = [];
    for (const [name, updater] of this.project) {
      seen.add(name);
      out.push({ name: updater.name, source: 'project' });
    }
    for (const [name, updater] of this.user) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name: updater.name, source: 'user' });
    }
    for (const [alias, updater] of Object.entries(BUILTIN_UPDATERS)) {
      // Aliases (e.g. `asymmetric`) resolve to the same updater; list each canonical name once.
      const canonical = updater.name.toLowerCase();
      if (seen.has(alias.toLowerCase()) || seen.has(canonical)) continue;
      seen.add(alias.toLowerCase());
      seen.add(canonical);
      out.push({ name: updater.name, source: 'builtin' });
    }
    return out;
  }
}
