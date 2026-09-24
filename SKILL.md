---
name: medha
description: Evidential memory for rules, recipes and tools. Use when deciding how far to trust a review rule, recipe or tool based on how it has actually performed — record uses, rejections and guard results, and read back trust hints. Medha reports evidence; it never decides.
---

# medha

Medha remembers how well rules, recipes and tools have actually worked and returns **trust hints**.
You record evidence; **you** decide what to do with it.

## Setup

Run once per project (creates `.medha/`; add it to `.gitignore` or commit it deliberately):

```sh
medha init
```

MCP server (register in `.mcp.json`): `{ "mcpServers": { "medha": { "command": "medha", "args": ["mcp", "serve"] } } }`

## Entities

An entity is addressed by `namespace` (default empty), `kind` (`rule` | `recipe` | `tool`, default
`rule`) and `id`. New entities start on **probation**.

## Workflow

1. **Read** before relying on a rule: MCP `hints` (pass `compact: true` for cheap output) or
   `medha show --id <id>`. `hints` returns `{ hints, unknown }` — treat `unknown` keys as probation.
2. **Propose** a new rule: `propose` / `medha propose --id <id> --source <who> [--text ..]`.
3. **Record** evidence as it happens: `record_signal` / `medha record --id <id> --signal APPLY --ensure`.
   Signals: `APPLY` (used and worked), `REJECT_RULE` (a human rejected it), `SKIP` (not applicable).
   If the entity is unknown and `ensure` is not set, the response says `recorded: false` — nothing was written.
4. **Report guards**: `report_guard` / `medha guard --id <id> --ok|--fail --guard review`.
   Without a passing guard, trust is capped at 0.5 — usage alone never makes a rule `trusted`.
5. **Explain**: `medha explain-threshold --id <id>` lists each threshold with ok/no and the numbers.
6. **Preview** with `simulate` (persists nothing) before recording a consequential signal.

## Lifecycle

`probation → active → trusted`, and down to `quarantined` / `retired` on repeated rejection.
`drift` lists entities whose recent behavior diverges from their baseline.

## Rules of thumb

- Trust is a hint, not a verdict: Wilson lower bound over successes/trials, decayed, gated by guards.
- Use `--json` on any CLI command for machine output; `--home <dir>` to point at a shared home.
- `medha maintain preflight` checks store integrity; `medha maintain backup <path>` exports a snapshot.
