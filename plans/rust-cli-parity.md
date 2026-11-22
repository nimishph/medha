---
id: plan/rust-cli-parity
status: draft
---

# Rust CLI parity with the TypeScript CLI

0.8.0-alpha.1 shipped the Rust CLI (`crates/medha-cli`) as `@cntxt-labs/medha-cli`, on the strength
of the medha-dvv parity gate. A black-box test of the published alpha found that the gate did not
hold: run through `MEDHA_CLI_BINARY`, the Rust binary fails 114 of the 219 cases in the TypeScript
CLI suite (`cli/src/**/*.test.ts`). Output text, `--json` shapes, flags and whole subcommands differ
from the TypeScript CLI, which is the reference and what the README documents.

The trust maths already agree (the engine parity test and a 30-step black-box scenario match to six
decimals). This plan is about the CLI surface around them.

Working rule: the TypeScript CLI suite is the spec. A difference is fixed in Rust unless the
TypeScript behaviour is the bug, in which case both change (ADR-0001: every behaviour change lands
in both engines).

## Requirement: the TypeScript CLI suite passes against the Rust binary {#req-suite-green}

`MEDHA_CLI_BINARY=<rust medha> bun test cli/src` passes, and a package script runs it so the gate
can be re-run and wired into CI.

```yojana:claim
kind: text
expression: test:cli-parity in package.json
```

## Requirement: human output matches the TypeScript CLI {#req-text-output}

Statuses print lowercase everywhere (`probation`, not `Probation`). `show` prints the ema/baseline
line, `clears:`, typed recent episodes with ISO times, and provenance. `propose` says whether it was
promoted and why. `explain-threshold`, `pack`, `status`, `list` and `drift` use the TypeScript
layout. Errors print `error: <message>` plus `(CODE)`, and as a JSON error object under `--json`.

```yojana:claim
kind: text
expression: /status:\s+Probation|"Probation"/ in crates/medha-cli/src/**/*.rs
expect: false
```

## Requirement: --json output has the TypeScript shapes {#req-json-shapes}

Every command's `--json` output has the keys and casing of the TypeScript CLI (for example `record`
returns `home`, `key`, `signal`, `recorded` and a hint with `trustScore`, `components`, `evidence`,
`temporal`, `clearsThreshold`), so hooks and scripts can switch binaries without changes.

```yojana:claim
kind: text
expression: /"wilson_lower"/ in crates/medha-cli/src/**/*.rs
expect: false
```

## Requirement: flags and argument validation match {#req-flags}

`record --case-id`, `guard --ensure`, and every other flag the TypeScript CLI accepts exist in Rust.
Invalid values are rejected the same way: an empty `--id`, a negative `--budget`, an unknown signal,
a case id that is not a branch of the entity.

```yojana:claim
kind: text
expression: /case_id/ in crates/medha-cli/src/args.rs
```

## Requirement: init scaffolds and reports like the TypeScript CLI {#req-init}

`init` writes `.medha/.gitignore` and `.medha/README.md`, keeps the agent section in AGENTS.md /
CLAUDE.md, validates `--config` strictly, honours `--backend`, `--namespace`, `--recreate` and
`--backup`, and reports backend, store, config, preflight and the files it wrote (text and JSON).

```yojana:claim
kind: text
expression: /README\.md/ in crates/medha-cli/src/main.rs
```

## Requirement: remaining command groups match {#req-commands}

`maintain`, `mcp config`, `decision` / `define`, `updater`, `keys`, `sync`, `--help` groups and the
namespace-scoped home behave as the TypeScript CLI does.

```yojana:claim
kind: path
expression: crates/medha-cli/src/mcp_config.rs
```
