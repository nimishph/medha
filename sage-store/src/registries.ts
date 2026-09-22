import {
  BUILTIN_KINDS,
  CANONICAL_SIGNALS,
  KindRegistry,
  SignalRegistry,
  type SignalSpec,
  type StoreRegistries,
} from '@sutras/sage-core';

/**
 * Rehydrate the guarded registries from the store's persisted lists. Built-ins (the three model
 * kinds, the four canonical signals) are always present; the store's lists are additive.
 * The persisted lists are the store-side source of truth for registry contents.
 */

/** The effective registries of a store: built-ins always present, host lists additive. */
export function resolveRegistries(host: StoreRegistries | undefined): StoreRegistries {
  const kinds = [...new Set([...BUILTIN_KINDS, ...(host?.kinds ?? [])])];
  const canonical = new Set(CANONICAL_SIGNALS.map((s) => s.name));
  const additive = (host?.signalSpecs ?? []).filter((s) => !canonical.has(s.name));
  const anchorKinds = [...new Set(['week', ...(host?.anchorKinds ?? [])])];
  return { kinds, signalSpecs: [...CANONICAL_SIGNALS, ...additive], anchorKinds };
}

export function kindRegistryFor(kinds: readonly string[]): KindRegistry {
  return new KindRegistry(kinds);
}

export function signalRegistryFor(specs: readonly SignalSpec[]): SignalRegistry {
  // Canonical signals keep fixed semantics; host registrations are additive and never override.
  const canonical = new Set(CANONICAL_SIGNALS.map((s) => s.name));
  const additive = specs.filter((s) => !canonical.has(s.name));
  return new SignalRegistry([...CANONICAL_SIGNALS, ...additive]);
}
