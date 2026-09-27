/**
 * The `Decision` variants a `DecisionCase` branch can hold (§11a).
 *
 * Kept in its own module with zero dependencies so `kinds.ts`'s `KindDecisionPolicy` can reference
 * `Decision['type']` without importing `decision.ts` itself, whose own dependency chain reaches
 * back into `kinds.ts` (via `trust.ts`/`recency.ts`) and would otherwise form an import cycle.
 */
export type Decision =
  | { readonly type: 'apply' }
  | { readonly type: 'ignore' }
  | { readonly type: 'probability'; readonly value: number };
