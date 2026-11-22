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
expression: /README\.md/ in crates/medha-cli/src/init.rs
```

## Requirement: remaining command groups match {#req-commands}

`maintain`, `mcp config`, `decision` / `define`, `updater`, `keys`, `sync`, `--help` groups and the
namespace-scoped home behave as the TypeScript CLI does.

```yojana:claim
kind: path
expression: crates/medha-cli/src/mcp_config.rs
```

## Requirement: the Rust engine signs episodes {#req-engine-signing}

The two remaining `medha keys` cases need episode signing in the Rust engine: in `require` mode a
write is signed with the home's key and an author other than the key's principal is refused,
legacy (unsigned) episodes count only after `keys adopt`, rotation keeps past episodes valid and
deletes the old private key, and revocation disowns a key's episodes. Today every Rust write
stores `sig: None`; `crates/medha-cli/src/keys.rs` manages keys but nothing signs with them.

```yojana:claim
kind: text
expression: '/sig: Some\(/ in crates/medha/src/engine.rs'
```

## Requirement: help lists distill and styles on a terminal {#req-help}

`medha --help` lists every command the TypeScript CLI has, `distill` included (the Rust CLI has no
`distill` command yet, though the MCP `distill_trajectory` tool exists), and adds bold section
headings only when stdout is a terminal.

```yojana:claim
kind: text
expression: /Distill/ in crates/medha-cli/src/args.rs
```

## Status and known gaps (2026-11-22)

Gate: `bun run test:cli-parity` passes 214 of 219 (was 105). Left: 2 `keys` cases
(req-engine-signing), 2 `--help` cases (req-help), and the MCP subprocess handshake, which cannot
pass through this gate: the TypeScript CLI's `MEDHA_CLI_BINARY` delegation runs the binary with
`spawnSync`, so an interactive stdio session never streams. The Rust server lists the TypeScript
server's 19 tools; a direct handshake works.

Found along the way, not yet addressed:

- The Rust core still treats `ADOPTED`, `HEURISTIC` and `FLAKY` as built-in signals when a home has
  no registries. `init` now writes the TypeScript registries (the canonical four), so configured
  homes match; an engine opened without a config does not.
- The Rust engine applies only the `ema` weight updater; `record --updater` accepts only `ema`.
- MCP tool outputs (not covered by the CLI suite) still serialize Rust-shaped hints.
- `cli/src/docs.ts` shows an MCP config with `"args": ["mcp"]`; both CLIs need `["mcp", "serve"]`.
- Deliberate difference kept: without `--dir`/`--home`, the Rust CLI also looks for `.medha/` in
  parent directories (hooks run from subdirectories rely on it).
