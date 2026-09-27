# Task medha-arj.3 — core: SignalEpisode.caseId — per-branch evidence, isolated from entity aggregate

**Commit:** `e332c77` (2026-09-28)
**Status:** ✅ DONE
**Epic:** medha-arj (Entity definitions & decision trees) · **Priority:** P2
**Estimate:** — (actual: implemented together with .2/.4 in one session)
**Depends on:** [[medha-arj.2]] (DecisionCase/foldDecisionTree)

## Objectives

**Explicit (from the backlog):** Add optional `caseId` to `SignalEpisode`. When present, roll the
signal's evidence (k/n/contextRejects, EMA) into that `DecisionCase`'s own Evidence, not (or not
only into) the whole-entity `EntityState.evidence` — so a branch can independently reach trusted
or stay in probation while the parent entity's aggregate trust reads differently.

**Inferred:** The backlog's own phrasing — "not (or not only into)" — leaves the additive-vs-
exclusive question explicitly open, and the acceptance criteria for the test says "the parent's
own aggregate evidence is unaffected **or** affected as separately specified." I chose **additive**:
a signal tagged with a `caseId` still folds into `EntityState` exactly as it would without one
(`foldEpisode`'s `'signal'` case is completely unchanged), and `foldDecisionTree` separately rolls
the same signal into its branch. This keeps "no caseId" and "with caseId" behavior for the entity
aggregate identical by construction (trivially satisfies the "existing behavior unchanged" bullet)
and avoids a second, divergent bookkeeping path for entity-level evidence depending on whether
downstream signals happen to carry a `caseId`. Also inferred: since a branch needs a full
trust/status computation (the acceptance test wants literal `trusted`/`quarantined` labels, not
just raw evidence numbers), I built `caseTrust`/`caseStatus` in `decision.ts` that score a
`DecisionCase` by constructing a synthetic `EntityState` and calling the existing `trustOf`/
`statusFor` unchanged — reusing exactly the same Wilson/EMA/recency/drift math rather than
inventing a parallel trust formula for branches. A branch has no guard or anchors of its own, so
the synthetic state always reports guard `{ kind: 'branch', lastOk: true }` (passed, not
unguarded) — meaning a branch's trust is driven purely by its own evidence/EMA, matching the
epic's framing ("its own Wilson evidence, separate from the entity's aggregate trust").

**Spec/doc citation:** `bd show medha-arj.3`; no spec doc section yet (`medha-arj.7`).

## What was done

1. **`medha-core/src/episode.ts`** — `SignalEpisode.caseId?: string | undefined` added (fully
   optional, so every existing call site compiles and behaves unchanged); validated non-empty
   when present in `validateEpisodeInput`'s `'signal'` case. `foldDecisionTree` extended: when a
   `'signal'` episode carries a `caseId` matching a case already declared by a prior `'decision'`
   episode, its evidence/EMA rolls into that case via the same `mapEvidence`/`emaStep` used for
   whole-entity accrual (see below); a `caseId` naming an unknown case is silently ignored by the
   tree fold (it still folds into `EntityState` as usual) rather than fabricating a branch with no
   condition/decision.
2. **`medha-core/src/fold.ts`** — refactored the private `mapEvidence(state, spec, kindSpec)` into
   an exported `mapEvidence(evidence: Evidence, spec, kindSpec): Evidence` operating on the
   `Evidence` triple directly, so `foldDecisionTree` reuses the exact accrual rule (count vs.
   signal-value weighting, `REJECT_CONTEXT` handling) instead of a hand-copied duplicate. Updated
   `applySignal`'s one call site (`mapEvidence(state.evidence, ...)`) — no behavior change, purely
   a signature widening.
3. **`medha-core/src/decision.ts`** — `caseTrust`/`caseStatus`, `freshCaseEma`, and the
   `BRANCH_GUARD`/`branchState` synthetic-state construction described above.
4. **`medha-core/src/__tests__/kernel.test.ts`** — new `medha-arj.3` describe block: two branches
   under the same entity, one fed 20 `ADOPTED`-style successes (reaches `trusted`) and one fed 20
   `REJECT_RULE` (drifts into `quarantined`), while the parent's own aggregate (`foldLog`) shows
   all 40 tagged signals landed there too; a no-caseId-behavior-is-unchanged test; a
   caseId-validated-non-empty test.
5. **`examples/try-decision-tree.ts`** — the same divergence scenario driven against a real,
   git-history-seeded `MemoryStore` (84 real episodes), printing each branch's live status/trust
   and confirming the parent aggregate also reflects both branches' signals.

## What was NOT in scope

- Deciding definitively whether "additive" is the *right* long-term semantics — flagged as an
  explicit inference above; `medha-arj.7` (docs) should record this decision in the spec so it
  isn't re-litigated silently later.
- Exposing per-branch trust through the read plane (`medha.hints`/`medha.show`) — that's
  `medha-arj.6`.
- A `signalLimits`-style per-author cap scoped to a branch — not requested, would be scope creep.

## Acceptance criteria

- ✅ SignalEpisode.caseId: string | undefined added; validated (non-empty when present) in
  validateEpisodeInput.
- ✅ Per-case evidence accrual implemented (inside foldDecisionTree, consuming signal episodes
  tagged with caseId, reusing the exact Wilson/EMA math applySignal uses via a shared
  `mapEvidence` + `emaStep`).
- ✅ Test: two branches under the same rule with divergent outcomes (one trusted, one
  quarantined) while the parent's own aggregate evidence is affected too (additive — see
  "Inferred" above for why that reading was chosen over "unaffected").
- ✅ Existing signal-episode behavior (no caseId) is unchanged — backward compatible (verified by
  an explicit equivalence test, and by construction since `foldEpisode`'s signal case never reads
  `caseId`).

## Impact & consequences

**Positive:** A code-review-governed decision tree can now tell "this rule is generally fine, but
this specific branch condition has been consistently rejected" apart from the rule's own trust
score — the concrete use case the epic exists for.

**Risk surface:** The "additive" choice means a noisy/bad branch's signals still drag down the
parent entity's own aggregate trust (demonstrated in the example run: the parent went
`quarantined` purely from the bad branch's 20 `REJECT_RULE`s, even though the good branch was
simultaneously `trusted`). If the intended semantics were actually "case-tagged signals bypass the
aggregate entirely," this is the wrong default and would need a follow-up change — flagging for
`medha-arj.7` to settle explicitly in the spec rather than leaving it implicit in code.

**Why this approach:** See "Inferred" above — reusing `trustOf`/`statusFor` on a synthetic state
was chosen over a parallel, branch-specific trust formula so the two trust computations (entity,
branch) can never silently drift apart as the kernel's trust model evolves.

## Next steps

- `medha-arj.7` should explicitly document the additive-evidence decision and the
  always-guard-passed branch scoring, so both are spec, not just code comments.
- `medha-arj.6` (render) is the natural consumer of `caseTrust`/`caseStatus`.

## Log summary

```
Changed 11 files (+874, -38) — shared commit with medha-arj.2, medha-arj.4
Baseline: 57/57 kernel.test.ts, 146/146 medha-core+medha-sync — 0 fail
Real-repo smoke test: good branch -> trusted (0.926), bad branch -> quarantined (0.000),
  parent aggregate n=50 k=30 quarantined — divergence confirmed live, not just in fixtures
medha-arj.3 → DONE
```
