import { InvalidArgumentError, UnknownKindError } from './errors.ts';

/**
 * Open kinds validated by a registry, library spec §5.2.
 *
 * Built-ins are exactly the three kinds the model names: `rule`, `recipe`, `tool`.
 * Everything else (`locator`, `pitfall`, `constraint`, …) is registered by the host.
 * Unknown kinds fail loud with the full list of registered kinds — a typo is a bug.
 */

export const BUILTIN_KINDS = ['rule', 'recipe', 'tool'] as const;

export class KindRegistry {
  private readonly known = new Set<string>(BUILTIN_KINDS);

  constructor(builtins?: readonly string[]) {
    for (const b of builtins ?? []) this.register(b);
  }

  register(name: string): this {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new InvalidArgumentError('kind name', 'a non-empty string', name);
    }
    this.known.add(name);
    return this;
  }

  has(name: string): boolean {
    return this.known.has(name);
  }

  get all(): readonly string[] {
    return [...this.known];
  }

  requireKnown(kind: string): void {
    if (!this.known.has(kind)) {
      throw new UnknownKindError(kind, [...this.known]);
    }
  }
}
