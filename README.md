# medha

**Evidential memory for the rules, recipes and tools your agents rely on.**

Agents accumulate rules ("never leave `console.log` in a commit"), recipes ("how we run migrations")
and tools (an MCP server, a linter). Some of them help. Some are stale, wrong, or quietly ignored.
Most memory systems store *what was said* and treat all of it as equally true.

Medha stores *what happened*: each time something was applied, rejected, skipped, or checked by a
guard. From that record it computes a **trust hint** for every entity. It reports evidence and never
decides an action; you and your agent decide what to do with it.

- **Earned, not asserted.** A new rule starts on probation. Usage alone never makes it trusted; a
  passing guard is required.
- **Honest about small samples.** Trust uses a Wilson lower bound, so 2 successes out of 2 is not
  treated like 200 out of 200.
- **Explainable.** Every number can be traced: `medha show` splits trust into its components and
  `medha explain-threshold` says which bars were cleared and which were not.
- **One binary, no server.** CLI and MCP server in a single executable. State is an append-only
  episode log you can back up, compact, sync, or replay.

> [!NOTE]
> **Rust Core & TypeScript Hybrid Acceleration**: Medha provides both an active, full-featured TypeScript CLI/library ecosystem and a high-performance native Rust core. The native algorithms and trust computations are directly bridged to TypeScript and Node.js/Bun through our NAPI-RS adapter (`@cntxt-labs/medha-napi` / `crates/medha-napi`), providing native execution speeds while keeping the TypeScript CLI and npm packages fully supported. Standalone Rust binaries are also available (`crates/medha-cli`).

## Mental Model: The Dual-Loop Architecture

Most memory tools store unstructured chat history or flat key-value assertions. Medha acts as an **evidential calibration loop**:

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

- **The Fast Inner Loop**: When starting a task, agents query `hints` or `medha show`. Entities with high trust are injected into active context; probation or quarantined entities are discounted or ignored. **Medha reports evidence; you decide.**
- **The Slow Outer Loop**: As actions execute, the agent or test runner reports ground truth: did the rule work (`APPLY`), did a human reject it (`REJECT_RULE`), did an automated test pass (`guard --ok`)?
- **Trust Formula ($T$)**:
  $$T = \min\big(\text{ceiling}, L \times G \times R \times D\big)$$
  - **$L$ (Wilson Lower Bound)**: 95% confidence interval on success rate $k/n$. Protects against small-sample overconfidence ($2/2 \ne 200/200$).
  - **$G$ (Guard Factor)**: 1.0 if verified by test/AST guard; penalized if failing or unverified.
  - **$R$ (Recency Decay)**: Exponential decay based on time elapsed since last use (default 45-day half-life, floor 0.30).
  - **$D$ (Durability Factor)**: Logarithmic bonus for rules validated across multiple git commits, branches, or weeks.
  - **Ceiling**: Unguarded entities cannot exceed 0.50 (customizable per kind up to 0.85), preventing unverified heuristics from becoming `trusted`.

## Install

```sh
npm install -g @cntxt-labs/medha-cli      # or: bun add -g, pnpm add -g, npx @cntxt-labs/medha-cli
medha --version
```

It is a single self-contained program: no Node, Bun or Python is needed to run it. Linux, macOS (Apple silicon and Intel) and Windows are supported.

Prefer no package manager? Download the archive for your platform from the GitHub release, unpack it
and put `medha` (or `medha.exe`) on your `PATH`.

## A first session

```sh
medha init                                         # creates .medha/ in the current directory
medha propose --id no-console-log --source review  # a candidate rule enters on probation
```
```
medha: proposed rule/no-console-log (not promoted)
  reason:   Requires >= 2 converging sources; saw 1 (review)
  trust:    0.000  status: probation
```

Promotion needs agreement from at least two independent sources. Now record what happens as the
rule is used:

```sh
medha record --id no-console-log --signal APPLY --ensure    # used, and it worked
medha record --id no-console-log --signal APPLY
medha guard  --id no-console-log --ok --guard review        # a check that the rule still holds
```
```
medha: recorded APPLY on rule/no-console-log   trust: 0.103  status: probation
medha: recorded APPLY on rule/no-console-log   trust: 0.171  status: probation
medha: guard passed on rule/no-console-log     trust: 0.378  status: active
```

See why it is where it is:

```sh
medha show --id no-console-log
```
```
medha: rule/no-console-log (known)
  status:   active
  trust:    0.378  (wilson 0.342, guard 1.000, recency 1.000, durability 1.104, ceiling 1.000)
  evidence: 2/2 successes, wilson lower bound 0.342
  temporal: ema 0.595, drift no (delta 0.095)
  clears:   trusted no, active yes
```
```sh
medha explain-threshold --id no-console-log
```
```
  trusted: not met
    no     trust 0.378 >= 0.6
    no     uses 2 >= 5
  active: MET
    ok     trust 0.378 >= 0.25
```

Before recording something consequential, preview it:

```sh
medha simulate --id no-console-log --signal REJECT_RULE
```
```
medha: simulate REJECT_RULE on rule/no-console-log
  trust:    0.378 -> 0.229 (delta -0.149)
  status:   active -> probation (changed)
```

Every command accepts `--json`. `medha --help` and `medha <command> --help` list all options.

## Concepts

**Entity.** The thing being trusted, addressed by `namespace` (default empty), `kind` and `id`. The
built-in kinds are `rule`, `recipe` and `tool`; you can register your own.

**Signal.** One piece of evidence about an entity.

| Signal | Meaning |
|---|---|
| `APPLY` | It was used and it worked. |
| `REJECT_RULE` | A human rejected it. |
| `SKIP` | It did not apply. Neutral: it never counts for or against. |

**Guard.** An independent check that the entity is still correct (a test, a linter run, a review).
Report the result with `medha guard --ok` or `--fail`.

**Episode.** Every proposal, signal and guard result is an immutable entry in an append-only log.
Entity state is a fold over that log, so it can always be rebuilt, audited, or corrected
(`medha retract`, `medha remove-episode`).

**Decision tree.** An entity can carry a tree of *branches*, each a condition plus a decision
(`apply`, `ignore`, or a probability). Branches earn their own trust from their own evidence, which
is what you want when a rule only holds in one situation: "always skip migration backups" can be
excellent advice in CI and wrong on a laptop.

```sh
medha decision --id migration-notes --condition "in CI" --apply
medha decision --id migration-notes --condition "on a laptop" --ignore --parent <case-id>
```

Evidence is then attributed to a branch as well as to the entity, so a branch can read `trusted`
while the entity as a whole reads `probation`:

```sh
medha record --id migration-notes --signal APPLY --case-id <case-id>
```

`caseId` must name a branch of that entity — a typo is rejected rather than silently filed against
the entity. Attributing evidence to a branch never *replaces* the entity-level fold; it is a second
view of the same signal.

Editing a branch (`medha decision --id .. --condition .. --case-id <case-id>`) changes its decision
and leaves it where it is. Pass `--parent <case-id>` to move it, or `--detach` to promote it to the
top level. Writes that name an unknown parent, a descendant of themselves, or a condition a sibling
already uses are rejected.

### How trust is computed

```
trust = min( ceiling,  wilson × recency × durability × guard )
```

| Component | What it does |
|---|---|
| **Wilson lower bound** | A conservative estimate of the true success rate given `k` successes in `n` trials. Small samples score low. |
| **Recency** | Evidence decays with a 45-day half-life, down to a floor, so old wins fade. |
| **Durability** | A bonus (up to 1.5×) for evidence that has held up over time. |
| **Guard** | Scales trust by the outcome of guard results. |
| **Ceiling** | Caps trust at **0.5 while no guard has passed**, so usage alone can never reach `trusted`. |

Separately, an exponential moving average watches for **drift**: entities whose recent behaviour
diverges from their baseline show up in `medha drift`.

`medha params` prints every constant and threshold.

### Lifecycle

```
probation ──► active ──► trusted
    │            │
    └────────────┴──► quarantined / retired   (repeated rejection; trust below 0.1)
```

| Status | Bar |
|---|---|
| `active` | trust ≥ 0.25 |
| `trusted` | trust ≥ 0.6, at least 5 uses, and a passing guard |

## Use it from an agent (MCP)

Register the server in your project's `.mcp.json`:

```json
{ "mcpServers": { "medha": { "command": "medha", "args": ["mcp", "serve"] } } }
```

Or let medha write it for your client: `medha mcp config --list` shows the clients it knows
(Claude Code, Cursor, GitHub Copilot / VS Code, opencode, Claude Desktop) with their scopes, and
`medha mcp config <client> --write` merges the entry into that client's file without touching the
other servers there. Without `--write` it prints the snippet; `--scope user`, `--launcher npx` and
`--all` change what it renders.

Then copy [`SKILL.md`](SKILL.md) to
`.claude/skills/medha/SKILL.md` so the agent knows when and how to use it.

| Tool | Purpose |
|---|---|
| `hints` | Batch-fetch trust hints for the entities you are about to rely on. Returns `{ hints, unknown }`; treat `unknown` as probation. |
| `list_entities` | Paginated search by kind, status, namespace or drift. |
| `show_entity` | Full detail for one entity: components, temporal state, recent episodes. |
| `record_signal` | Record `APPLY`, `REJECT_RULE`, `SKIP`, and so on. Returns `recorded: false` for an unknown entity unless `ensure` is set. Pass `caseId` to also teach a decision-tree branch. |
| `record_decision` | Create or edit a branch of an entity's decision tree. Pass `parentId` to nest it, or `detach: true` to promote it to the top level. Returns the minted `caseId`. |
| `report_guard` | Record a guard result. |
| `propose` | Submit a candidate entity. |
| `drift` | List drifting entities. |
| `simulate` | Preview a signal's effect; persists nothing. |
| `status` | Engine health and preflight. |

### Claude Code plugin

In Claude Code, the plugin brings the MCP server (pinned to this version, through `npx`), the agent
skill and four read-side slash commands (`/medha:hints`, `/medha:status`, `/medha:drift`,
`/medha:pack`) in one install:

```text
/plugin marketplace add nimishph/cntxt-labs
/plugin install medha@cntxt-labs
```

### Fitting trust into a prompt

`medha pack --budget 2000` selects the active and probation rules that fit a token budget, so a
host can inject the most trusted guidance without overrunning its context.

## Inspect and share

- **`medha primer [topic]`** reads token-frugal agent guidance on specific topics (`overview`, `mental-model`, `signals`, `guards`, `decisions`, `drift`, `config`, `sync`).
- **`medha ui`** launches a local real-time web dashboard over the store.
- **`medha report`** writes a standalone, offline HTML snapshot you can attach to a review.
- **`medha issue [title]`** prepares a GitHub issue prefilled with sanitized runtime and store diagnostics.
- **`medha sync status|pull|push`** shares evidence between machines through a git ref or a file.
  Registries travel with the episodes, so custom kinds and signals do not have to be copied by hand.
- **Documentation**: Complete guides and reference are published at [nimishph.github.io/medha](https://nimishph.github.io/medha/). In this repository, run `bun run docs:dev` to launch the local VitePress documentation reader.

## Extend it

- **Kinds and signals.** Register your own in `.medha/config.json`. A kind can set its own trust
  thresholds and recency half-life, and can weight evidence by a signal's value (for example, a
  timeout counts less against a tool than a crash). See [Kind specs](#kind-specs) below.
- **Weight updaters.** Swap how evidence moves trust with `medha updater list` and `medha updater fork <name>`, which scaffolds a custom one.

### Kind specs

A **kind spec** gives one kind its own policy. Pass them to `medha init --config <file>`:

```json
{
  "kindSpecs": [
    {
      "name": "lint",
      "description": "linter rules: frequent, cheap evidence",
      "thresholds": { "active": 0.15, "trusted": 0.4, "minUsesForTrusted": 3 },
      "recency": { "halfLifeDays": 20, "floor": 0.2 },
      "evidenceWeighting": "signal-value"
    },
    {
      "name": "rule",
      "signalLimits": { "maxSuccessesPerAuthor": 3 },
      "decisionPolicy": { "requireHumanFor": ["apply"] }
    }
  ]
}
```

```sh
medha init --config medha.config.json
```

`--config` adds to the built-in kinds (`rule`, `recipe`, `tool`) rather than replacing them. A spec
naming a new kind (`lint` above) also registers it, and a spec naming a built-in kind (`rule`) sets
that kind's policy. Every field except `name` is optional, and a field you leave out keeps its
default.

| Field | Keys (default) | What it does |
|---|---|---|
| `thresholds` | `active` (0.25), `trusted` (0.6), `minUsesForTrusted` (5), `retiredTrustThreshold` (0.1), `minUsesForRetired` (3), `unguardedCeiling` (0.5) | Where the lifecycle transitions sit for this kind. `unguardedCeiling` caps trust while no guard has passed; no threshold lets an unguarded entity become `trusted`. |
| `recency` | `halfLifeDays` (45), `floor` (0.3) | How fast old evidence fades, and the least it fades to. |
| `evidenceWeighting` | `"count"` (default) or `"signal-value"` | Count each signal as one trial, or weight it by the signal's value. |
| `signalLimits` | `minIntervalMs`, `maxSuccessesPerAuthor` (both off) | Limit how much one author can raise trust. Negative evidence is never limited. |
| `decisionPolicy` | `requireHumanFor`: `"apply"` or a list of `apply`/`ignore`/`probability` (off) | Decision-tree branches of these types need a `human:` author. This is a label the caller sets, not verification: it stops an agent that follows instructions, not one that lies. |

Config files are strict: an unknown key, such as `kindPolicies` or `thresholds.bogus`, is refused with
the list of allowed keys, so a typo cannot quietly leave a policy switched off.

To change specs after `init`, edit `.medha/config.json`. There they live under
`registries.kindSpecs`, and a new kind's name must also be added to `registries.kinds`. Run
`medha maintain preflight` to check the result. [Extending medha](https://nimishph.github.io/medha/guide/extending)
covers kinds, signals and updaters in depth.

## Maintain it

```sh
medha maintain preflight                  # verify store integrity and registry match
medha maintain compact --older-than 90    # fold old episodes into baselines, and say what was folded
medha maintain backup snapshot.json       # atomic, portable snapshot
medha maintain restore snapshot.json
```

Everything lives under `.medha/`. `medha init` scaffolds a `.medha/.gitignore` and a
`.medha/README.md` for you, and keeps a short medha section in the project's `AGENTS.md` /
`CLAUDE.md` (or `--agents-file <path>`; `--no-agents-file` for none) so coding agents know to use
it. Re-run `medha init` after an upgrade: the store is left alone and that section is refreshed. `config.json` (the registries) is meant to be committed, while the
store data itself is gitignored by default — share it with `medha sync` instead, since it has its
own conflict-resolving merge, not git's. Delete or edit `.medha/.gitignore` if you'd rather commit
the store file directly as a simpler, manual sync.

## Author & Attribution

Authored by **[@nimishph](https://github.com/nimishph)**.

## License

MIT © [Nimish Phalnikar](https://github.com/nimishph)
