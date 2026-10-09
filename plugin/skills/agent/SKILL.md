---
name: agent
description: Evidential memory for rules, recipes and tools. Use when deciding how far to trust a review rule, recipe or tool based on how it has actually performed — record uses, rejections and guard results, and read back trust hints. Medha reports evidence; it never decides.
---

# medha

Medha remembers how well rules, recipes and tools have actually worked and returns **trust hints**.
You record evidence; **you** decide what to do with it.

## Mental Model: Dual-Loop Architecture

```text
                    THE DUAL-LOOP MENTAL MODEL
 
  ┌──────────────────────────────────────────────────────────────┐
  │                 FAST INNER LOOP: EXECUTION                   │
  │                                                              │
  │   Agent Task ──► Query Trust Hints ──► Context Injection     │
  │                         │                                    │
  │                         ▼                                    │
  │               Should I apply this rule?                      │
  │              (Agent / Human Decision)                        │
  └────────────────────────┬─────────────────────────────────────┘
                           │ Outcomes observed
                           ▼
  ┌──────────────────────────────────────────────────────────────┐
  │                 SLOW OUTER LOOP: EVIDENCE                    │
  │                                                              │
  │   Record Signals & Guard Checks (APPLY, REJECT, PASS/FAIL)   │
  │                         │                                    │
  │                         ▼                                    │
  │              Evidential Trust Engine                         │
  │        T = min(Ceiling, L × G × R × D)                       │
  │     Wilson Lower Bound (L) × Guard Factor (G)                │
  │     × Recency Decay (R) × Durability (D)                     │
  │                         │                                    │
  │                         ▼                                    │
  │       Calibrated Status: Probation ──► Active ──► Trusted    │
  │                                 └──► Quarantined / Retired   │
  └──────────────────────────────────────────────────────────────┘
```

- **Fast Inner Loop**: Read `hints` (or `medha show`) before applying rules. Treat unknown entities as `probation`.
- **Slow Outer Loop**: Report ground truth as events occur (`record_signal`, `report_guard`).
- **Trust Formula**: $T = \min(\text{ceiling}, L \times G \times R \times D)$. Usage alone never exceeds 0.50 (customizable up to 0.85); a passing guard is required to achieve `trusted`.

## Setup

Run once per project (creates `.medha/`; add it to `.gitignore` or commit it deliberately). It also
keeps a short medha section in the project's `AGENTS.md` / `CLAUDE.md` (`--agents-file <path>` to
name another file, `--no-agents-file` for none). Running it again after an upgrade is safe: the store
is left alone and the section is refreshed to the new version.

```sh
medha init
```

MCP server (register in `.mcp.json`): `{ "mcpServers": { "medha": { "command": "medha", "args": ["mcp", "serve"] } } }`

## Entities

An entity is addressed by `namespace` (default empty), `kind` (`rule` | `recipe` | `tool`, default
`rule`) and `id`. New entities start on **probation**.

## Per-kind policy (kindSpecs)

A kind can carry its own policy. Set it at init with `medha init --config <file>`:

```json
{ "kindSpecs": [
  { "name": "lint", "thresholds": { "active": 0.15, "trusted": 0.4, "minUsesForTrusted": 3 },
    "recency": { "halfLifeDays": 20 }, "evidenceWeighting": "signal-value" },
  { "name": "rule", "signalLimits": { "maxSuccessesPerAuthor": 3 },
    "decisionPolicy": { "requireHumanFor": ["apply"] } }
] }
```

- Allowed keys: `name`, `description`, `thresholds` (`active`, `trusted`, `minUsesForTrusted`,
  `retiredTrustThreshold`, `minUsesForRetired`, `unguardedCeiling`), `recency` (`halfLifeDays`,
  `floor`), `evidenceWeighting` (`count` | `signal-value`), `signalLimits` (`minIntervalMs`,
  `maxSuccessesPerAuthor`), `decisionPolicy` (`requireHumanFor`). An unknown key is an error.
- A spec for a new kind registers it too; built-in kinds stay. Omitted fields keep their defaults.
- After init, specs live in `.medha/config.json` under `registries.kindSpecs`, and a new kind's
  name must also be listed in `registries.kinds`. Check with `medha maintain preflight`.
- `decisionPolicy.requireHumanFor` means **a human must run that command**. If you get
  `CORE_PERMISSION_DENIED`, do not retry with a `human:` author. You can set that label yourself,
  so passing it proves nothing. Escalate to a human instead.

## Workflow
 
0. **Understand on demand**: Use MCP `primer` or `medha primer [topic]` for focused, token-frugal guidance on topics (`overview`, `mental-model`, `signals`, `guards`, `decisions`, `drift`, `config`, `sync`).
1. **Read** before relying on a rule: MCP `hints` (pass `compact: true` for cheap output) or
   `medha show --id <id>`. `hints` returns `{ hints, unknown }` — treat `unknown` keys as probation.
2. **Propose** a new rule: `propose` / `medha propose --id <id> --source <who> [--text ..]`.
3. **Record** evidence as it happens: `record_signal` / `medha record --id <id> --signal APPLY --ensure`.
   Signals: `APPLY` (used and worked), `REJECT_RULE` (a human rejected it), `SKIP` (not applicable).
   If the entity is unknown and `ensure` is not set, the response says `recorded: false` — the attempt is logged, but changes no entity.
4. **Report guards**: `report_guard` / `medha guard --id <id> --ok|--fail --guard review`.
   Without a passing guard, trust is capped at 0.5 — usage alone never makes a rule `trusted`.
5. **Explain**: `medha explain-threshold --id <id>` lists each threshold with ok/no and the numbers.
6. **Preview** with `simulate` (persists nothing) before recording a consequential signal.

## Branching a rule (only when a rule is only good sometimes)

A rule that holds in one situation and not another belongs in a decision tree, not in a single
trust number. `record_decision` mints a branch and returns its `caseId`:

```
record_decision { id, condition: "in CI",          decision: { type: "apply" } }
record_decision { id, condition: "on a laptop",    decision: { type: "ignore" }, parentId: <first> }
```

Then attribute evidence to the branch, not just the entity:

```
record_signal { id, signal: "APPLY", caseId: <branch> }
```

Read a branch's own trust with `show_entity` — `decisionTree` lists each branch with its `parentId`,
condition, evidence and status. Branch evidence is *in addition to* the entity's aggregate, never a
replacement for it, so an entity can be `probation` while one branch is `trusted`.

- `caseId` must be a real branch of that entity; a typo is rejected, not filed against the entity.
- Editing a branch by `caseId` without `parentId` leaves it exactly where it is. Pass `parentId` to
  move it, or `detach: true` to make it a root.
- Two branches with the same condition under the same parent are rejected — the same condition once
  under each of two roots is fine.

## Lifecycle

`probation → active → trusted`, and down to `quarantined` / `retired` on repeated rejection.
`drift` lists entities whose recent behavior diverges from their baseline.

## Rules of thumb

- Trust is a hint, not a verdict: Wilson lower bound over successes/trials, decayed, gated by guards.
- Use `--json` on any CLI command for machine output; `--home <dir>` to point at a shared home.
- `medha maintain preflight` checks store integrity; `medha maintain backup <path>` exports a snapshot.
