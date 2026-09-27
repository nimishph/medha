# Task medha-arj.6 — cli+render: medha show renders definition + decision tree with per-branch trust

**Commit:** `bd3b4bf` (2026-09-28)
**Status:** ✅ DONE
**Epic:** medha-arj (Entity definitions & decision trees) · **Priority:** P2
**Estimate:** — (actual: implemented together with `[[medha-arj.5]]` in one session)
**Depends on:** [[medha-arj.1]], [[medha-arj.2]], [[medha-arj.3]] (definition/tree/per-branch trust)

## Objectives

**Explicit (from the backlog):** Extend `runShow` (`medha/src/index.ts`) to merge
`foldDefinitions` + `foldDecisionTree` output into `ShowReport` alongside the existing
`EntityState`. Extend `render.ts`'s `renderShow` to print the definition (title/tags/rationale)
and the decision tree as an indented forest with per-case status/k/n, matching the epic's example
output format. `--json` output includes both as structured fields.

**Inferred:** The backlog names `medha/src/index.ts` for `runShow`, but that file is a 16-line
barrel (`export * from './engine.ts'` etc.) — `runShow` and `ShowReport` actually live in
`cli/src/read.ts`, and the fold outputs are naturally computed inside `Medha.show()`
(`medha/src/engine.ts`), which already fetches the full per-key episode slice `foldDefinitions`/
`foldDecisionTree` need. I extended `EntityDetail` (engine.ts) with the fold outputs — the correct
layer, since it's the one place that already has the episode slice, the `KindSpec`, and `context.now`
in hand — and then added *convenience passthrough* fields on `ShowReport` itself
(`report.definition`/`report.decisionTree`, mirroring `report.key`) so the literal acceptance
criterion ("ShowReport gains optional definition and decisionTree fields") holds without
duplicating the fold logic at a second layer. Also inferred: per-case `status`/`trust` needed to be
computed *somewhere* for "an indented forest with per-case status/k/n" to be renderable at all —
`DecisionCase` alone (from `[[medha-arj.2]]`) carries no status. Added `ScoredDecisionCase`/
`scoreDecisionTree` in `decision.ts` (medha-core) rather than computing status in the CLI's render
layer, so the render layer never needs its own copy of the trust/status math or a `KindSpec` to do
it — it just reads `case.status`/`case.trust` off the already-scored value.

**Spec/doc citation:** `bd show medha-arj.6`; no spec doc section yet (`medha-arj.7`).

## What was done

1. **`medha-core/src/decision.ts`** — `ScoredDecisionCase extends DecisionCase` (`+ status: `
   `LifecycleStatus, trust: number`) and `scoreDecisionTree(tree, now, kindSpec):
   ScoredDecisionCase[]`, built from the existing `caseStatus`/`caseTrust` (from
   `[[medha-arj.3]]`).
2. **`medha/src/engine.ts`** — `EntityDetail` gains `definition?: EntityDefinition` and
   `decisionTree?: readonly ScoredDecisionCase[]`; `show()` computes both from the same
   `episodes` slice it already filters for `recentEpisodes`/`provenance` (so a definition or tree
   renders even for an unknown id with no signal history — neither is evidential), scoring the
   tree via `scoreDecisionTree(foldDecisionTree(...), context.now, this.kindSpecFor(key.kind))`.
   Fields are omitted (not set to `undefined`) when there's nothing to show, per the "silently
   omit" acceptance criterion.
3. **`cli/src/read.ts`** — `ShowReport` gains the same two optional fields as a passthrough of
   `detail.definition`/`detail.decisionTree`, populated in `runShow`.
4. **`cli/src/render.ts`** — `renderShow` prints `definition: <title>` / `tags:` / `rationale:`
   when a definition exists, and a `decision tree:` section built by a new
   `renderDecisionForest` helper: root cases first (a `parentId` naming a case not present in the
   tree — a dangling reference — renders that case as a root rather than dropping it silently),
   each line `<condition> -> <decision>  [<status>]  k=<k> n=<n>  (<id>)`, children indented two
   spaces deeper per level. Both sections are omitted entirely when absent — verified no layout
   change for an existing entity with neither.
5. **`medha/src/__tests__/read-plane.test.ts`** — new `medha-arj.1/.2/.3` describe block (test IDs
   don't split cleanly per the read-plane test file's existing per-concern grouping, so it's
   grouped by what `show()` exercises): omission when neither exists; a full definition + 2-level
   tree round-trip with live per-branch evidence/parentId; a definition surfacing for a known-false
   (never-signaled) id.
6. **`cli/src/cli.test.ts`** — covered under `[[medha-arj.5]]`'s tasklog (the CLI integration tests
   there exercise `show`'s rendering as part of the define/decision round trip).
7. **Live verification**: ran `medha show` (both text and `--json`) against a real file-backend
   store after `medha define` + two `medha decision` calls (root + child) — confirmed the
   indented-tree text output, the `--json` structured fields nested correctly, and that an entity
   with neither definition nor tree renders exactly as it did before this change (no regression).

## What was NOT in scope

- Any change to how `medha list`/`medha status`/`medha pack` render — only `show` was in scope per
  the backlog.
- Handling a *retracted* `define`/`decision` episode specially in the render — the underlying
  retraction-masking gap flagged in `[[medha-arj.1]]`'s and `[[medha-arj.2]]`'s tasklogs is
  unchanged; `medha-arj.7`/`.8` should address it at the fold level, not here.

## Acceptance criteria

- ✅ ShowReport gains optional definition and decisionTree fields (as a passthrough of
  `EntityDetail`'s, computed at the engine layer — see "Inferred" for why).
- ✅ renderShow prints title/tags/rationale when a definition exists, and an indented tree
  (condition -> decision, status, k/n) when decision cases exist, silently omitting both when
  absent (no layout regression for existing entities) — verified live.
- ✅ --json includes the same data unrendered — verified live (`detail.definition`,
  `detail.decisionTree`, and the `ShowReport`-level passthrough all present in real `--json`
  output).
- ✅ Snapshot/unit test covers an entity with both a definition and a multi-level decision tree
  (`read-plane.test.ts`'s new describe block; a 2-level tree with a root + parented child).

## Impact & consequences

**Positive:** `medha show` is now the single place a host or agent can see an entity's full
picture — aggregate trust, host-authored definition, and every decision branch with its own live
status — closing the read-plane half of the epic.

**Risk surface:** `ScoredDecisionCase`'s `status`/`trust` are computed fresh on every `show()` call
(not cached/stored), so they always reflect `context.now` — correct, but means two `show()` calls
at different times for the same log can report different branch statuses purely from recency
decay, same as the entity's own aggregate hint already does. Not a bug, just worth knowing.

**Why this approach:** Considered storing computed status/trust directly on the persisted
`DecisionCase` (e.g., in a snapshot), but that would violate the same non-evidential/fold-purity
invariant `[[medha-arj.1]]` and `[[medha-arj.2]]` establish — status must stay a *read-time*
derivation, never persisted state, or replay/compaction could disagree with a stale cached value.

## Next steps

- `[[medha-arj.7]]` should document the definition/decision-tree render format as the canonical
  example output the epic's description sketches.
- `[[medha-arj.8]]` conformance vectors could add a fixture exercising `scoreDecisionTree` output
  directly, if the spec wants a golden-file check on the render format.

## Log summary

```
Changed 10 files (+705, -10) — shared commit with medha-arj.5
Baseline: 491 pass / 3 fail (pre-existing, unrelated)
Live CLI smoke: medha show (text + --json) after define + 2 decisions — definition, indented
  2-level tree with live status/trust, and omission-when-absent all confirmed against a real store
medha-arj.6 → DONE
```
