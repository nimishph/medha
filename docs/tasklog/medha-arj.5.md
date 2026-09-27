# Task medha-arj.5 — cli: medha define and \<kind\> \<id\> decision \<condition\> \<decision\> [--parent]

**Commit:** `bd3b4bf` (2026-09-28)
**Status:** ✅ DONE
**Epic:** medha-arj (Entity definitions & decision trees) · **Priority:** P2
**Estimate:** — (actual: implemented together with `[[medha-arj.6]]` in one session)
**Depends on:** [[medha-arj.1]], [[medha-arj.2]], [[medha-arj.4]] (define/decision episodes,
decisionPolicy enforcement)

## Objectives

**Explicit (from the backlog):** New CLI surface: `medha define <namespace/kind/id> --title
--rationale [--tags]` appends a define episode. `medha rule <id> decision <condition>
<apply|ignore|--probability N> [--parent <case-id>]` (generalizes to any kind, not just rule)
appends a decision episode, minting a case id via `newDecisionCaseId` when creating a new branch.
Wire into `cli/src/commands.ts` + `options.ts` following the existing `showCommand`/`signalCommand`
patterns.

**Inferred:** The backlog's literal decision syntax — `medha rule <id> decision <condition>
<apply|ignore|--probability N>` — is positional (kind and id as bare arguments before the verb),
which no other command in this CLI uses. Every existing write command (`record`, `guard`,
`propose`, `retract`) is a flag-based subcommand: `medha record --id x --kind y --signal APPLY`.
I implemented `decision` (and `define`) the same way — `medha decision --kind tool --id t1
--condition "..." --apply` — for consistency with the rest of the CLI's argument surface, rather
than introducing a second, positional argument-parsing style that citty (the CLI framework in use
here) doesn't naturally support alongside subcommands. This is a deliberate deviation from the
backlog's literal syntax, flagged here rather than silently done.

**Spec/doc citation:** `bd show medha-arj.5`; no spec doc section yet (`medha-arj.7`).

## What was done

1. **`medha/src/engine.ts`** — added `Medha.define(key, definition, context, options)` and
   `Medha.decision(key, input, context, options)`, mirroring the existing `record`/`reportGuard`/
   `override` write-method shape (`sanitizeContext` → `ensureOpen` → `validateKey` →
   `requireKind` → `checkWritePermission` → build `EpisodeInput` → `store.append`). `decision`
   mints a fresh `caseId` via `newDecisionCaseId(key, options.random)` unless `input.caseId` is
   given to edit an existing branch. Also added `SignalEpisode.caseId` passthrough to
   `RecordOptions`/`record()` so `medha.record(key, signal, ctx, { caseId })` ties a signal to a
   branch (needed for `[[medha-arj.3]]` to be reachable from the write plane at all).
2. **`cli/src/options.ts`** — `defineCommandArgs`, `decisionCommandArgs` (flag surfaces per the
   "Inferred" note above).
3. **`cli/src/write.ts`** — `DefineOptions`/`DefineReport`/`runDefine`, `DecisionOptions`/
   `DecisionReport`/`runDecision`, plus `renderDefine`/`renderDecision` for human-readable output —
   placed alongside `runRecord`/`runGuard`/`runPropose` (the existing write-plane runners and their
   renderers both live in `write.ts`, not `render.ts`, which I confirmed by reading the file before
   assuming otherwise).
4. **`cli/src/commands.ts`** — registered `defineEntityCommand` (named this, not `defineCommand`,
   to avoid shadowing citty's imported `defineCommand` factory) under `medha define`, and
   `decisionCommand` under `medha decision`.
5. **`cli/src/cli.test.ts`** — new `medha-arj.5` describe block: define + show round-trip; a root
   decision case plus a child under `--parent` rendering as an indented tree; the
   `--apply/--ignore/--probability` mutual-exclusivity validation; a `decisionPolicy`-gated kind
   rejecting an agent author (exit 1, `CORE_PERMISSION_DENIED` in stderr, no stack trace) and
   accepting a human one.
6. **Live verification against a real `file`-backend store** (not just the test harness): ran
   `medha init`, `medha define`, `medha decision` (both accepted and policy-rejected), and
   `medha show --json` as actual child processes against a throwaway home, confirming the full
   round trip end to end including the `CORE_PERMISSION_DENIED` rejection path.

## What was NOT in scope

- The literal positional `medha <kind> <id> decision ...` syntax — explicitly deviated from (see
  "Inferred").
- `medha show` rendering — that's `[[medha-arj.6]]`, done alongside in the same commit but its own
  task/tasklog.
- Any interactive/TTY-aware author attribution (e.g. auto-detecting "this session is a human
  typing at a terminal" to skip requiring `--author human:...`) — out of scope; the CLI's existing
  `resolveAuthor` (env var fallback) is used unchanged, so a `decisionPolicy`-gated kind still
  requires the caller to pass `--author human:<id>` explicitly.

## Acceptance criteria

- ✅ medha define command implemented, validated args (options.ts), wired in commands.ts.
- ✅ medha decision command implemented (as a flag-based subcommand generalizing to any kind, not
  positional — see "Inferred"); omitted --parent attaches to root (no parentId set);
  --probability and apply/ignore are mutually exclusive and validated (a CLI test covers the
  exit-2 rejection).
- ✅ Both commands surface the typed policy-rejection error from decisionPolicy cleanly (non-zero
  exit, readable message) rather than a stack trace — verified both in a CLI integration test and
  manually against a live process.
- ✅ CLI integration tests cover: create root case, add child under an explicit parent, reject an
  unauthorized apply branch.

## Impact & consequences

**Positive:** A human (or a script acting on a human's behalf) can now grow/edit a decision tree
and record host-authored definitions from the shell, the same way `medha record`/`medha guard`
already let them feed evidence — completing the write-plane surface the epic needs before an agent
or reviewer workflow can use any of this for real.

**Risk surface:** The flag-based command shape is a real, intentional deviation from the backlog's
literal example syntax. If the backlog's positional shape was load-bearing for some external
integration already written against it, this would need reconciling — but nothing in the repo
referenced that syntax before this task, so I judged the consistency argument to dominate.

**Why this approach:** See "Inferred." A positional `medha <kind> <id> <verb>` shape would also
have required either a new citty routing layer or per-kind dynamic subcommand registration,
meaningfully larger than the flag-based surface every other write command already uses.

## Next steps

- `[[medha-arj.7]]` (docs) should record the CLI syntax decision so the backlog's literal example
  doesn't mislead a future reader of the spec.
- `[[medha-arj.8]]` (conformance vectors) doesn't depend on CLI syntax and is unaffected.

## Log summary

```
Changed 10 files (+705, -10) — shared commit with medha-arj.6
Baseline: 491 pass / 3 fail (pre-existing, unrelated) across medha-core+store+sync+medha+cli
Live CLI smoke: init -> define -> decision (accepted + policy-rejected) -> show --json, all via
  real child-process `bun run cli/src/bin.ts` calls against a throwaway file-backend home
medha-arj.5 → DONE
```
