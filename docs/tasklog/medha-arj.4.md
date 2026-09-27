# Task medha-arj.4 — core: KindSpec.decisionPolicy.requireHumanFor — gate who can grant an apply branch

**Commit:** `e332c77` (2026-09-28)
**Status:** ✅ DONE
**Epic:** medha-arj (Entity definitions & decision trees) · **Priority:** P2
**Estimate:** — (actual: implemented together with .2/.3 in one session; the store-layer bug fix
below took roughly as long as the feature itself)
**Depends on:** [[medha-arj.2]] (DecisionEpisode/Decision types)

## Objectives

**Explicit (from the backlog):** Add `decisionPolicy?: { requireHumanFor?: readonly
Decision['type'][] | 'apply' }` to `KindSpec`. Enforce in `validateEpisodeInput` for decision
episodes: if the kind's policy requires a human author for this decision type and the episode's
author doesn't match the configured human-author convention, reject with a typed error.

**Inferred:** The backlog assumes a "human-author convention" already exists, but nothing in the
codebase defines one (existing test fixtures use ad hoc author strings like `'agent:alpha'`,
`'reviewer:bob'`, `'mcp-agent'`, with no consistent tagging). I defined a new, explicit,
default-deny convention in `isHumanAuthor`: an author counts as human only when it's a string
starting with `'human:'`; every other value — including `undefined`/anonymous — fails a
human-gated check. I chose default-deny (opt-in allow-list) rather than default-allow
(opt-out block-list, e.g. "anything not starting with `agent:`") specifically because this is a
security-relevant gate: an unrecognized or missing author should never silently pass a check whose
entire purpose is restricting who may act.

**Spec/doc citation:** `bd show medha-arj.4`; no spec doc section yet (`medha-arj.7`).

## What was done

1. **`medha-core/src/decision.ts`** — `isHumanAuthor(author): boolean`, documented as the
   default-deny convention above.
2. **`medha-core/src/kinds.ts`** — `KindDecisionPolicy { requireHumanFor?: readonly
   Decision['type'][] | 'apply' }` and `KindSpec.decisionPolicy?: KindDecisionPolicy`;
   `KindRegistry.register` validates `decisionPolicy`'s shape (object, `requireHumanFor` either the
   literal `'apply'` or an array of valid `Decision['type']` values) mirroring the existing
   `thresholds`/`recency`/`signalLimits` validation style in the same method.
3. **`medha-core/src/episode.ts`** — in `validateEpisodeInput`'s `'decision'` case, look up the
   kind's `KindSpec` from the `EpisodeValidation.kinds` registry; if `decisionPolicy.requireHumanFor`
   gates this episode's `decision.type` and `isHumanAuthor(input.author)` is false, throw
   `PermissionDeniedError` naming the kind and decision type.
4. **`medha-core/src/__tests__/kernel.test.ts`** — new `medha-arj.4` describe block: a
   `tool-gate`-style kind with `requireHumanFor: 'apply'` rejects an agent-authored `apply` and
   accepts a human-authored one, while `ignore`/`probability` on the same kind stay ungated
   (agent-editable); a kind with no `decisionPolicy` accepts either author for `apply`.
5. **Store-layer bug fix (discovered via the real-repo smoke test, not a unit test)** — see below.

## What was NOT in scope

- Any actual authentication/identity system verifying that an author string tagged `human:x`
  really was submitted by a human — this is a naming convention the write plane (CLI, agents) must
  honor when constructing episodes; it is not cryptographically enforced. Out of scope per the
  backlog, which only asked for the gate on the string convention.
- Wiring the CLI (`medha-arj.5`) to actually stamp `human:<id>` authorship when a human runs a
  command interactively vs. an agent running non-interactively — that has to happen wherever the
  CLI's author-attribution currently lives, and is naturally `medha-arj.5`'s concern, not this
  core-only task's.

## Acceptance criteria

- ✅ KindSpec.decisionPolicy field added and validated in KindRegistry.register (mirrors existing
  thresholds/recency/signalLimits validation style).
- ✅ validateEpisodeInput rejects a decision episode granting a policy-gated decision type from a
  non-human author, with a clear typed error (`PermissionDeniedError`, code
  `CORE_PERMISSION_DENIED`) naming the kind and the missing authorization.
- ✅ Test: a kind with decisionPolicy.requireHumanFor='apply' rejects an agent-authored
  apply-branch decision episode and accepts a human-authored one; a kind without the policy
  accepts either — plus the same scenario driven for real through a live `MemoryStore.append()`
  call in `examples/try-decision-tree.ts` (see below for why that mattered).

## Impact & consequences

**Positive:** `tool-gate` (human-gated tree growth) and `code-review` (agent-editable tree)
governance modes are both now real and enforced at the point episodes enter the log, using the
same `DecisionEpisode` type — exactly the epic's stated goal.

**Risk surface / what this caught:** Driving this feature against a real, populated `MemoryStore`
(not just calling `validateEpisodeInput` directly, the way a unit test does) surfaced a
**pre-existing bug across all three store backends**: `MemoryStore`/`FileStore`/`SqliteStore`'s
`append()`, `replaceLog()`, and open-time log validation all built their `KindRegistry` from the
registries' bare `kinds: readonly string[]` list, silently discarding any registered `KindSpec`
(thresholds, recency, signalLimits, and now `decisionPolicy`). Only the internal fold/projection
path (`accept()`) used `kindSpecs ?? kinds`. Net effect: a `decisionPolicy` (or any other per-kind
config) registered on a store was applied when *scoring* an entity but never *enforced* when
*writing* one — a `decisionPolicy` gate would have been completely inert through the normal write
path in production, only "working" if you called `validateEpisodeInput` by hand. **Fixed** by
changing every validation call site in `memory-store.ts`, `file-store.ts`, and `sqlite-store.ts` to
build the `KindRegistry` from `kindSpecs ?? kinds`, matching what `accept()` already did. This is a
correctness fix for the store layer generally (it would have silently affected `signalLimits` and
custom `thresholds`/`recency` too, not just this new feature) — I judged it in-scope to fix rather
than merely note, since leaving it would have made `medha-arj.4` decorative rather than real. All
127 medha-store tests still pass after the change.

**Why this approach:** Considered leaving the store bug for a separate task, but a "done" tasklog
for a policy gate that doesn't actually gate anything through the write plane would be a
vacuous-truth pass — exactly what the tasklog-writer skill's fail-honest guidance warns against.

## Next steps

- `medha-arj.5` (CLI) needs to decide how/when a CLI-issued decision episode gets `author:
  'human:<id>'` vs `'agent:<id>'` — this task only defines the convention, not who stamps it.
- `medha-arj.7` should document `isHumanAuthor`'s default-deny convention as the canonical
  human-author tagging scheme for the whole system (it doesn't currently exist anywhere else).
- Worth a follow-up sweep for any other place in the store layer that might read `kinds` instead of
  `kindSpecs` (I searched exhaustively for `kindRegistryFor` call sites and believe all are now
  fixed, but a dedicated audit task would close the loop with certainty).

## Log summary

```
Changed 11 files (+874, -38) — shared commit with medha-arj.2, medha-arj.3
Baseline: 57/57 kernel.test.ts, 146/146 medha-core+medha-sync, 127/127 medha-store — 0 fail
Store bug fix verified: decisionPolicy now enforced through store.append(), not just
  validateEpisodeInput called directly — confirmed live (CORE_PERMISSION_DENIED thrown, then
  accepted with human: author) in examples/try-decision-tree.ts
medha-arj.4 → DONE
```
