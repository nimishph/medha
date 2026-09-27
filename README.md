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
- **Safe to try.** `medha simulate` shows what a signal would do without recording anything.
- **One binary, no server.** CLI and MCP server in a single executable. State is an append-only
  episode log you can back up, compact, sync, or replay.

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

Then copy [`SKILL.md`](SKILL.md) to
`.claude/skills/medha/SKILL.md` so the agent knows when and how to use it.

| Tool | Purpose |
|---|---|
| `hints` | Batch-fetch trust hints for the entities you are about to rely on. Returns `{ hints, unknown }`; treat `unknown` as probation. |
| `list_entities` | Paginated search by kind, status, namespace or drift. |
| `show_entity` | Full detail for one entity: components, temporal state, recent episodes. |
| `record_signal` | Record `APPLY`, `REJECT_RULE`, `SKIP`, and so on. Returns `recorded: false` for an unknown entity unless `ensure` is set. |
| `report_guard` | Record a guard result. |
| `propose` | Submit a candidate entity. |
| `drift` | List drifting entities. |
| `simulate` | Preview a signal's effect; persists nothing. |
| `status` | Engine health and preflight. |

### Fitting trust into a prompt

`medha pack --budget 2000` selects the active and probation rules that fit a token budget, so a
host can inject the most trusted guidance without overrunning its context.

## Inspect and share

- **`medha ui`** launches a local web dashboard over the store.
- **`medha report`** writes a standalone, offline HTML snapshot you can attach to a review.
- **`medha sync status|pull|push`** shares evidence between machines through a git ref or a file.
  Registries travel with the episodes, so custom kinds and signals do not have to be copied by hand.

## Extend it

- **Kinds and signals.** Register your own in `.medha/config.json`. A kind can set its own trust
  thresholds and recency half-life, and can weight evidence by a signal's value (for example, a
  timeout counts less against a tool than a crash).
- **Weight updaters.** Swap how evidence moves trust with `medha updater list` and `medha updater fork <name>`, which scaffolds a custom one.

## Maintain it

```sh
medha maintain preflight                  # verify store integrity and registry match
medha maintain compact --older-than 90    # fold old episodes into baselines, and say what was folded
medha maintain backup snapshot.json       # atomic, portable snapshot
medha maintain restore snapshot.json
```

Everything lives under `.medha/`. `medha init` scaffolds a `.medha/.gitignore` and a
`.medha/README.md` for you: `config.json` (the registries) is meant to be committed, while the
store data itself is gitignored by default — share it with `medha sync` instead, since it has its
own conflict-resolving merge, not git's. Delete or edit `.medha/.gitignore` if you'd rather commit
the store file directly as a simpler, manual sync.

## Author & Attribution

Authored by **[@nimishph](https://github.com/nimishph)**.

## License

MIT © [Nimish Phalnikar](https://github.com/nimishph)
