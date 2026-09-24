import { InvalidArgumentError, InvariantViolationError, UnknownSignalError } from './errors.ts';

/**
 * Signals, library spec §5.5.
 *
 * A signal is a spec, not a bare string:
 *
 *     SignalSpec { name, value: s ∈ [-1,1], countsAsTrial, countsAsSuccess }
 *
 * The four canonical signals keep fixed semantics because Invariants I–IV depend on them:
 *   APPLY          +1.0  trial, success
 *   SKIP            0.0  not a trial            (missing in the legacy ReviewSignal type — added)
 *   REJECT_CONTEXT -0.2  not a trial
 *   REJECT_RULE    -1.0  trial, not success
 *
 * Hosts extend by registering a spec or an alias over a canonical signal. Registration validates
 * the spec so a malicious or careless host cannot break the invariants:
 *   - Invariant III: a signal with value 0 counts as a trial → rejected.
 *   - Invariant IV:  a spec that claims a trial is also a success while having value ≤ 0 is
 *                    rejected (only ≥0 values may count as success), so a host cannot make a
 *                    "failing success" inflate the evidence.
 */

export interface SignalSpec {
  readonly name: string;
  /** Signal value s ∈ [-1, 1]. */
  readonly value: number;
  /** Whether this signal increments n (the trial count). */
  readonly countsAsTrial: boolean;
  /** Whether, when it is a trial, this signal increments k (the success count). */
  readonly countsAsSuccess: boolean;
}

export const APPLY: SignalSpec = {
  name: 'APPLY',
  value: 1,
  countsAsTrial: true,
  countsAsSuccess: true,
};
export const SKIP: SignalSpec = {
  name: 'SKIP',
  value: 0,
  countsAsTrial: false,
  countsAsSuccess: false,
};
export const REJECT_CONTEXT: SignalSpec = {
  name: 'REJECT_CONTEXT',
  value: -0.2,
  countsAsTrial: false,
  countsAsSuccess: false,
};
export const REJECT_RULE: SignalSpec = {
  name: 'REJECT_RULE',
  value: -1,
  countsAsTrial: true,
  countsAsSuccess: false,
};

export const CANONICAL_SIGNALS: readonly SignalSpec[] = [APPLY, SKIP, REJECT_CONTEXT, REJECT_RULE];

/**
 * Validate a spec. Throws InvariantViolationError with the broken invariant on violation,
 * InvalidArgumentError on malformed shape.
 */
export function validateSignalSpec(spec: SignalSpec): void {
  if (typeof spec.name !== 'string' || spec.name.trim() === '') {
    throw new InvalidArgumentError('signal spec.name', 'a non-empty string', spec.name);
  }
  if (
    typeof spec.value !== 'number' ||
    !Number.isFinite(spec.value) ||
    spec.value < -1 ||
    spec.value > 1
  ) {
    throw new InvalidArgumentError('signal spec.value', 'a finite number in [-1, 1]', spec.value);
  }
  if (spec.countsAsSuccess && !spec.countsAsTrial) {
    throw new InvariantViolationError(
      `signal '${spec.name}' counts as success but not as a trial`,
      { context: { spec, invariant: 'II' } },
    );
  }
  if (spec.value === 0 && spec.countsAsTrial) {
    throw new InvariantViolationError(
      `signal '${spec.name}' has value 0 and counts as a trial — a neutral signal must never touch n`,
      { context: { spec, invariant: 'III' } },
    );
  }
  if (spec.countsAsTrial && spec.countsAsSuccess && spec.value < 0) {
    throw new InvariantViolationError(
      `signal '${spec.name}' has a negative value but counts as a success`,
      { context: { spec, invariant: 'IV' } },
    );
  }
}

/** All registered signal names, in registration order. */
export function signalNames(registry: ReadonlyMap<string, SignalSpec>): string {
  return [...registry.keys()].join(', ');
}

/** Resolve a signal by name, preferring the canonical set, then registered, then aliases. */
export class SignalRegistry {
  private readonly specs = new Map<string, SignalSpec>();
  private readonly aliases = new Map<string, string>();

  constructor(seed?: readonly SignalSpec[]) {
    for (const spec of seed ?? CANONICAL_SIGNALS) this.register(spec);
  }

  register(spec: SignalSpec): this {
    validateSignalSpec(spec);
    if (this.specs.has(spec.name) && !CANONICAL_SIGNALS.some((c) => c.name === spec.name)) {
      throw new InvalidArgumentError(
        'signal spec.name',
        'a name not already registered',
        spec.name,
      );
    }
    this.specs.set(spec.name, spec);
    return this;
  }

  /** Map a host's vocabulary onto an existing signal name. */
  alias(aliasName: string, targetName: string): this {
    if (typeof aliasName !== 'string' || aliasName.trim() === '') {
      throw new InvalidArgumentError('aliasName', 'a non-empty string', aliasName);
    }
    if (!this.specs.has(targetName)) {
      throw new UnknownSignalError(targetName, 'alias target');
    }
    this.aliases.set(aliasName, targetName);
    return this;
  }

  /** Resolve an explicit signal name; unknown names fail loud. */
  resolve(name: string): SignalSpec {
    const direct = this.specs.get(name);
    if (direct !== undefined) return direct;
    const target = this.aliases.get(name);
    if (target !== undefined) {
      const resolved = this.specs.get(target);
      if (resolved !== undefined) return resolved;
    }
    throw new UnknownSignalError(name, signalNames(this.specs));
  }

  has(name: string): boolean {
    return this.specs.has(name) || this.aliases.has(name);
  }
}
