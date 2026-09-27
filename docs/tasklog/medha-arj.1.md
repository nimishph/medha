# Task medha-arj.1 — core: EntityDefinition type + define episode + foldDefinitions

**Commit:** `f54f722` (2026-09-27)
**Status:** ✅ DONE
**Epic:** medha-arj (Entity definitions & decision trees) · **Priority:** P2
**Estimate:** — (actual: single focused session, ~1 hour)
**Depends on:** —

## Objectives

**Explicit (from the backlog):** Add `EntityDefinition` (title, tags?, rationale) and a `define`
episode type in medha-core (entity.ts / episode.ts). Add `foldDefinitions(episodes):
Map<entityKeyString, EntityDefinition>` as a fold entirely separate from `foldEpisode` — define
episodes are a no-op in `foldEpisode`'s trust fold.

**Inferred:** The backlog said "entity.ts / episode.ts" for the type's home, but I put
`EntityDefinition` and its validator in a new `definition.ts` file instead, matching this repo's
existing one-concern-per-file convention (`guard.ts`, `hint.ts`, `signals.ts` etc. each own their
type + validator), then imported it into `episode.ts`. Also inferred: `foldDefinitions` returns
`Map<string, EntityDefinition>` keyed by `entityKeyString(key)` (a plain string), matching the
literal acceptance-criteria signature `Map<entityKeyString, EntityDefinition>` where
`entityKeyString` names the key shape, not a branded type. Also touched `medha-sync/src/merge.ts`
(out of the epic's core-only scope) to give `define` episodes a real content key in
`canonicalEpisodeKey`/`contentKey`, since leaving it out would have made two different definitions
at the same timestamp collide and dedupe incorrectly during merge — the same bug class the
existing `retract`-key comment (medha-8gx) warns about.

**Spec/doc citation:** `bd show medha-arj` / `bd show medha-arj.1` (epic and task description);
no spec doc section yet — `medha-arj.7` (docs) is the sibling task that will add one to the trust
spec.

## What was done

1. **`medha-core/src/definition.ts`** (new) — `EntityDefinition` interface (title, tags?,
   rationale) and `validateEntityDefinition`, mirroring `validateEpisodeInput`'s per-field
   `InvalidArgumentError` style used elsewhere in the package.
2. **`medha-core/src/episode.ts`** — added `DefineEpisode` to the `Episode`/`EpisodeInput` unions;
   `validateEpisodeInput` validates it via `validateEntityDefinition`; `assignSeq` handles it;
   `foldEpisode` treats `'define'` as a pure no-op (`return prev`) so it can never create or
   mutate `EntityState`, matching how `'retract'` is handled; added and exported
   `foldDefinitions(episodes)`, a from-scratch fold that sorts by `seq` and does
   latest-write-wins per `entityKeyString(key)`, ignoring every other episode type.
3. **`medha-core/src/index.ts`** — exported the new `definition.ts` module.
4. **`medha-core/src/__tests__/kernel.test.ts`** — added a `medha-arj.1` describe block: (a)
   fold-purity — a log with `define` episodes interleaved with a `signal` episode folds to the
   same `EntityState` as the log with the `define` episodes stripped; (b) `define` never creates
   an entity from `undefined` prior state even without an `ensure` flag; (c) `foldDefinitions`
   latest-write-wins across multiple keys and interleaved non-`define` episodes.
5. **`medha-sync/src/merge.ts`** — added a `'define'` case to `contentKey` pushing
   title/rationale/sorted-tags, so merge/dedup treats two different definitions as distinct
   content (see "Inferred" above for why).

## What was NOT in scope

- The rest of the `medha-arj` epic: `DecisionCase`/`decision` episodes (`medha-arj.2`),
  `SignalEpisode.caseId` (`medha-arj.3`), `KindSpec.decisionPolicy.requireHumanFor`
  (`medha-arj.4`), the `medha define` / `... decision` CLI (`medha-arj.5`), `medha show`
  rendering (`medha-arj.6`), spec docs (`medha-arj.7`), and the dedicated fold-purity /
  case-id-uniqueness conformance vectors (`medha-arj.8`) — each is its own child task.
- Any store-layer (`medha-store`) changes: stores serialize episodes as opaque JSON with no
  exhaustive `switch` over `episode.type`, so `DefineEpisode` round-trips through them with no
  code change needed; verified by grep, not by exercising a live store test for this type
  specifically.
- The pre-existing uncommitted migrations work already on disk in this working tree
  (`medha-core/src/migrations.ts`, `medha/src/snapshot-migrations.ts`, etc.) — unrelated,
  untouched, left exactly as found.

## Acceptance criteria

- ✅ EntityDefinition type added to medha-core/src (new definition.ts).
- ✅ DefineEpisode added to the Episode/EpisodeInput unions; validateEpisodeInput validates it
  (non-empty title/rationale).
- ✅ foldEpisode has a case define: return prev branch, confirmed by a test that a log of
  signal+define episodes produces the same EntityState as the log with all define episodes
  stripped.
- ✅ foldDefinitions(episodes) implemented and exported, latest-write-wins per key by seq order.

## Impact & consequences

**Positive:** Unblocks the rest of the `medha-arj` epic — `medha-arj.2`–`.8` all build on
`EntityDefinition`/`define` existing and being fold-pure. The definition layer is now provably
non-evidential (test-enforced), which is the epic's core invariant.

**Risk surface:** `foldDefinitions` does not currently mask a defined key when a later `retract`
episode targets that `define` episode's `seq` — `retract` masking is only wired into `foldLog`'s
trust fold, not into `foldDefinitions`. This wasn't in the stated acceptance criteria, but a future
task retracting a bad definition would find it still visible via `foldDefinitions`. Worth
flagging for whoever picks up `medha-arj.7`/`.8` in case the spec wants retraction semantics for
definitions too.

**Why this approach:** Kept `EntityDefinition` in its own file rather than folding it into
`entity.ts` (as the backlog text loosely suggested) to match the codebase's existing "one type +
its validator per file" pattern and avoid growing `entity.ts`, which is already the busiest file
in the package.

## Next steps

- `medha-arj.2` (DecisionCase/DecisionEpisode + foldDecisionTree) is the next natural child —
  it's independent of `.1` in the type sense but will likely want to sit next to `definition.ts`.
- `medha-arj.7` (docs) should record the retraction-masking gap noted above when it documents the
  fold-purity invariant.

## Log summary

```
Changed 5 files (+170, -7)
Baseline: 46/46 kernel.test.ts pass, 135/135 medha-core+medha-sync pass, 0 fail
Pre-existing typecheck errors (unrelated migrations WIP) unaffected — none touch the changed files
medha-arj.1 → DONE
```
