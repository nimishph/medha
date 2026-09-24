import type { EntityKey, EvidentialHint } from '@cntxt-labs/medha-core';
import { keyLabel } from './render.ts';

/** A one-line-per-entity hint for token-sensitive callers (MCP `compact`, `--json` pipelines). */
export interface CompactHint {
  readonly key: string;
  readonly trust: number;
  readonly status: string;
  readonly successes: number;
  readonly trials: number;
  readonly drifting: boolean;
}

export function compactHint(hint: EvidentialHint): CompactHint {
  return {
    key: keyLabel(hint.key),
    trust: hint.trustScore,
    status: hint.status,
    successes: hint.evidence.successes,
    trials: hint.evidence.totalTrials,
    drifting: hint.temporal.isDrifting,
  };
}

/**
 * Batch hints as a plain list plus the requested keys that do not exist — instead of a map keyed
 * by NUL-joined strings, which neither an LLM nor `jq` can address.
 */
export function shapeHints(
  requested: readonly EntityKey[],
  found: ReadonlyMap<string, EvidentialHint>,
  compact: boolean,
): { hints: readonly (EvidentialHint | CompactHint)[]; unknown: readonly EntityKey[] } {
  const present = new Set<string>();
  const hints: (EvidentialHint | CompactHint)[] = [];
  for (const hint of found.values()) {
    present.add(keyLabel(hint.key));
    hints.push(compact ? compactHint(hint) : hint);
  }
  const unknown = requested.filter((key) => !present.has(keyLabel(key)));
  return { hints, unknown };
}
