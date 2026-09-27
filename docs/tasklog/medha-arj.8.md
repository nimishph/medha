# Task medha-arj.8 — tests: conformance vectors for fold-purity and case-id uniqueness

**Commit:** `71e78a5` (2026-09-28)
**Status:** ✅ DONE
**Epic:** medha-arj (Entity definitions & decision trees) · **Priority:** P3
**Estimate:** — (actual: implemented together with `[[medha-arj.7]]` in one session)
**Depends on:** [[medha-arj.1]] through [[medha-arj.4]] (fold-purity, per-case isolation,
decisionPolicy — the three behaviors these vectors pin down)

## Objectives

**Explicit (from the backlog):** Add JSON conformance vectors (matching the existing
language-neutral vector format from medha-s7z.3) covering: (a) a log with define/decision episodes
interleaved with signal episodes produces identical `EntityState` whether or not the
define/decision episodes are present; (b) per-case evidence isolation from the caseId task; (c)
decisionPolicy rejection cases.

**Inferred:** The task's *title* says "case-id uniqueness" but its own acceptance criteria and
description only ask for (a)/(b)/(c) above — no case-id-format/collision vector is listed. I
followed the acceptance criteria (already covered thoroughly by unit tests in `[[medha-arj.2]]`'s
`kernel.test.ts` work: 500-sample no-collision + different-key-divergence tests) rather than the
title, and did not duplicate a case-id-uniqueness vector here. Also inferred: case ids cannot be
literal, portable JSON values the way `round6`/`wilsonLower` inputs are — `newDecisionCaseId`'s
output depends on the caller's `random` function, which is TS/mulberry32-specific by default. I
designed the vector format around a `caseRef` label (e.g. `"good"`, `"bad"`, `"root"`) that the
**runner** resolves to a real, freshly-minted case id before folding, so the vectors test the
fold's *behavior* (does a `decision` episode create a branch, does a tagged `signal` roll into it,
does `decisionPolicy` reject it) rather than pinning a specific id string that a different-language
port implementing the same documented algorithm would still reproduce byte-for-byte, but that
would be brittle and uninformative to hardcode here.

**Spec/doc citation:** `docs/spec/vectors/decision-tree.json`; `docs/spec/vectors/README.md`
(updated with a note on why this file, unlike the other two, is hand-authored and how `caseRef`
resolution works); `bd show medha-arj.8`.

## What was done

1. **`docs/spec/vectors/decision-tree.json`** (new) — three vector groups:
   - `foldPurity`: one scenario interleaving `define`, `signal`, and `decision` episodes; asserts
     the full log's folded state equals the same log with every `define`/`decision` episode
     stripped and resequenced, and both match the expected `evidence`/`status`.
   - `caseIsolation`: the good-branch/bad-branch divergence scenario (also proven live in
     `[[medha-arj.3]]`'s example run against a real repo) — 20 `ADOPTED` signals tagged to one
     case reaching `trusted`, 20 `REJECT_RULE` tagged to another reaching `quarantined`, and the
     parent entity's own aggregate reflecting all 40 (additive design, per `[[medha-arj.3]]`'s
     tasklog).
   - `decisionPolicyRejections`: four cases — a `tool-gate` kind rejecting an agent-authored
     `apply`, accepting a human-authored one, leaving `ignore` ungated, and a kind with no
     `decisionPolicy` accepting an agent `apply`.
2. **`docs/spec/vectors/README.md`** — new table row for `decision-tree.json`, plus a paragraph
   explaining it's hand-authored (not `generate.py` output — §11a's non-evidential metadata isn't
   part of the trust formula the Python reference re-derives) and how `caseRef` resolution works.
3. **`medha-core/src/__tests__/conformance.test.ts`** — a new `medha-arj.8` describe block:
   `buildEpisodes()` turns the vector's episode list (`define`/`signal`/`decision`/`signalBurst` —
   the last a compact way to express "N signals at a fixed cadence" without listing all 20 by
   hand) into real `Episode[]`, resolving `caseRef` via `newDecisionCaseId` seeded with
   `mulberry32` for reproducibility within the test run; then three test loops, one per vector
   group, driving `foldLog`/`foldDecisionTree`/`caseStatus`/`validateEpisodeInput` and asserting
   against each vector's `expected`/`expectedCases`/`expectedAggregate`/`rejected`.

## What was NOT in scope

- A literal case-id-format/collision vector (see "Inferred" — already covered by `kernel.test.ts`
  unit tests from `[[medha-arj.2]]`, and not asked for by this task's actual acceptance criteria).
- Extending `generate.py` (the Python reference) to model `define`/`decision` folding — a
  substantial undertaking or its own, and not what the acceptance criteria asked for (they ask for
  vectors "wired into the existing conformance test runner," which is satisfied without a second
  independent implementation existing for this non-evidential metadata).

## Acceptance criteria

- ✅ New conformance vectors added under the existing vectors directory/runner
  (`docs/spec/vectors/decision-tree.json`, wired into `conformance.test.ts`).
- ✅ Vectors pass against the reference implementation (44/44 new + existing conformance tests
  pass) and are wired into the existing conformance test runner
  (`medha-core/src/__tests__/conformance.test.ts`).

## Impact & consequences

**Positive:** The three most spec-relevant behaviors from this epic (fold-purity, per-case
isolation, decisionPolicy gating) now have a regression net at the conformance-vector layer, not
just scattered unit tests — a future refactor of `foldDecisionTree`/`validateEpisodeInput` that
silently breaks one of these will fail a conformance test explicitly labeled with the spec section
it violates.

**Risk surface:** Because `decision-tree.json` isn't independently re-derived by a second
implementation (unlike `components.json`/`scenarios.json`, which `generate.py` computes from the
spec text alone), these vectors can't catch a bug that's present in *both* the spec's prose and
the kernel's code — they pin down "this is what the code does today, and the spec agrees," not "an
independent reading of the spec produces the same numbers." Flagged in the README so this
limitation isn't mistaken for the same guarantee the other two files provide.

**Why this approach:** Considered writing the `caseRef`-resolution logic directly into
`decision-tree.json` as a "runner contract" doc rather than code, but decided the working
TypeScript runner in `conformance.test.ts` *is* the executable spec for how to resolve it — exactly
how `scenarios.json`'s README already points to `conformance.test.ts` as "the TypeScript reference
runner."

## Next steps

- This closes the `medha-arj` epic's task list (8/8). A natural follow-up, not part of this epic,
  would be extending `generate.py` itself to model `define`/`decision` if a genuinely independent
  second implementation of §11a is ever wanted.

## Log summary

```
Changed 12 files (+433, -20) — shared commit with medha-arj.7
Baseline: 44/44 new conformance vectors pass, 132/132 medha-core, 498/501 full-suite
  (3 pre-existing, unrelated failures)
medha-arj.8 → DONE — medha-arj epic: 8/8 complete
```
