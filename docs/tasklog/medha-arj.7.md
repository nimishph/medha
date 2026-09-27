# Task medha-arj.7 — docs: document EntityDefinition/DecisionCase in the trust spec, state the fold-purity invariant

**Commit:** `71e78a5` (2026-09-28)
**Status:** ✅ DONE
**Epic:** medha-arj (Entity definitions & decision trees) · **Priority:** P3
**Estimate:** — (actual: implemented together with `[[medha-arj.8]]` in one session)
**Depends on:** [[medha-arj.1]] through [[medha-arj.6]] (documents what they built)

## Objectives

**Explicit (from the backlog):** Update `docs/spec/trust-formula.md` (or add a companion doc) to
describe `EntityDefinition` and `DecisionCase`, their episode types, the case-id scheme, and
explicitly state the invariant that define/decision episodes never affect `EntityState` — trust
math is computed purely from signal/guard/override/proposal/sweep/baseline episodes; definitions
and decision-tree structure are metadata riding the same log.

**Inferred:** Chose to extend `trust-formula.md` directly (a new §11a) rather than a companion
doc, since the epic's whole point is that this metadata rides the *same* log the trust spec
already governs — a separate doc would have split one coherent episode-log story across two
files. Also inferred: the spec should explicitly record the two most consequential *design
decisions* made across `.1`–`.6` that the backlog itself left ambiguous, so a future reader of the
spec (not just the tasklogs) can find them: (a) per-case evidence is **additive**, not exclusive
(`[[medha-arj.3]]`'s inferred choice), and (b) the human-author convention is **default-deny**,
`human:<id>`-tagged only (`[[medha-arj.4]]`'s inferred choice). Both are now §11a.3/§11a.4, not
just tasklog notes.

**Spec/doc citation:** `docs/spec/trust-formula.md` §11a (new); `bd show medha-arj.7`.

## What was done

1. **`docs/spec/trust-formula.md`** — new §11a ("Definitions and decision trees, since 1.2.0")
   with five subsections: §11a.1 `EntityDefinition`/`define`, §11a.2 `DecisionCase`/`Decision`/
   `newDecisionCaseId`/`foldDecisionTree`, §11a.3 per-branch evidence isolation (states the
   additive design explicitly, and how a branch is scored with a synthetic always-guard-passed
   state), §11a.4 `KindSpec.decisionPolicy` (states the default-deny human-author convention),
   §11a.5 a named "known gap" — `retract` does not currently mask `define`/`decision` episodes.
   Also added one bullet to §10's invariant list citing §11a's fold-purity requirement, and bumped
   the header's stated spec version.
2. **`medha-core/src/thresholds.ts`** — `TRUST_SPEC_VERSION` `'1.1.0'` → `'1.2.0'` (minor bump per
   §12's own rule: additive episode types that leave every existing vector's expected output
   unchanged).
3. **`docs/spec/vectors/generate.py`, `components.json`, `scenarios.json`** — `specVersion`
   mirrored to `'1.2.0'` (hand-edited for the stamp only; no vector *content* changed, so no
   regeneration was needed or attempted — I don't have a Python interpreter in this environment,
   confirmed by a failed `python3` invocation earlier in the session, so I edited the three
   `specVersion` strings directly rather than running `generate.py`).
4. **`medha-core/src/episode.ts`, `decision.ts`, `definition.ts`, `kinds.ts`** — doc-comment
   cross-references to the new §11a subsections, per the acceptance criterion.

## What was NOT in scope

- Actually resolving the §11a.5 retraction gap — documented as an open question for a future spec
  revision, not fixed here (fixing it is a behavior change belonging to a `.2`/`.1`-adjacent code
  task, not a docs task).
- Rerunning `generate.py` — no vector *content* changed (only the version stamp), and I have no
  Python interpreter available in this session to verify a regeneration would be a no-op; hand-
  editing the three `specVersion` strings is the same edit `generate.py` would have produced.

## Acceptance criteria

- ✅ Spec doc updated with the new episode types and the fold-purity invariant stated explicitly,
  version-bumped per the existing TRUST_SPEC_VERSION convention (1.1.0 → 1.2.0, minor).
- ✅ Cross-referenced from medha-core/src/episode.ts doc comments (and decision.ts/definition.ts/
  kinds.ts, since those are where the actual types/policy live).

## Impact & consequences

**Positive:** The two most important, previously-implicit design decisions from this epic
(additive evidence, default-deny human authorship) are now spec, not just scattered tasklog notes
— the next person implementing a second port, or extending this feature, has one normative place
to read them.

**Risk surface:** The version bump changes `TRUST_SPEC_VERSION`'s literal value, which any
external consumer pinning to `'1.1.0'` would need to update. Given `[[medha-arj.1]]`-`.6`'s changes
are all additive (no existing vector's expected output moved), this should be a safe minor bump,
but it's a real, visible constant change worth flagging.

**Why this approach:** Considered leaving `TRUST_SPEC_VERSION` at 1.1.0 (since "if applicable" in
the backlog left it optional), but §12 of the spec itself is unambiguous that additive episode
types are exactly a minor-bump case — not bumping would have been the spec disagreeing with its
own stated rule.

## Next steps

- A future task should resolve §11a.5 (retraction masking for define/decision), informed by this
  spec section rather than re-deriving the tradeoff from scratch.
- If a second-language port of medha-core is ever built, §11a is now the normative reference for
  its define/decision/decisionPolicy behavior.

## Log summary

```
Changed 12 files (+433, -20) — shared commit with medha-arj.8
Baseline: 132/132 medha-core pass, 498/501 full-suite pass (3 pre-existing, unrelated failures)
medha-arj.7 → DONE
```
