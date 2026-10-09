---
title: Getting started
description: Install medha, create an engine home, and record enough evidence to move a rule off probation.
---

# Getting started

This page takes you from nothing to a rule that has earned `active` status, and shows how to read
the result. Every transcript below is real output from medha 0.5.0.

## Install

```sh
npm install -g @cntxt-labs/medha-cli      # or: bun add -g, pnpm add -g, npx @cntxt-labs/medha-cli
medha --version
```

It is a single self-contained program — no Node, Bun or Python is needed to *run* it. Linux, macOS
(Apple silicon and Intel) and Windows are supported.

Prefer no package manager? Download the archive for your platform from the
[GitHub release](https://github.com/nimishph/medha/releases), unpack it, and put `medha` (or
`medha.exe`) on your `PATH`.

## Create an engine home

Everything medha knows lives under a single directory, `.medha/`, in your project:

```sh
medha init
```

```
medha: initialized engine home at /your/project/.medha
  backend:    sqlite
  store:      /your/project/.medha/store.sqlite
  config:     /your/project/.medha/config.json (layout v1)
  preflight:  ok — 0 episodes, 0 entities, integrity ok
  last sweep: 2026-09-28T05:57:31.194Z
  gitignore:  /your/project/.medha/.gitignore
  readme:     /your/project/.medha/README.md
  agents:     created AGENTS.md with the medha section
```

`init` runs a preflight check before it hands back, so a home that reports `ok` is one medha can
read.

`init` also keeps a short section on using medha in the project's agent instruction file, so a
coding agent working there knows to check trust before leaning on a rule and to record what
happened. It goes into `AGENTS.md` and `CLAUDE.md`, whichever exist (a `CLAUDE.md` that only says
`@AGENTS.md` is skipped), and creates `AGENTS.md` when neither does. Name another file with
`--agents-file docs/agents.md`, or pass `--no-agents-file` for none. The section sits between
`<!-- medha:begin … -->` and `<!-- medha:end -->` markers; the rest of the file is never touched.

Running `medha init` again on an initialized home is safe, and is the step to take after upgrading
medha: the store and `config.json` are left as they are, preflight runs, and the agent section is
replaced with the one this version ships. Only `--recreate` wipes the store. See [Maintenance and sharing](/guide/maintenance) for what to commit and what to gitignore.

Three store backends are available, chosen with `--store`:

| Backend | Use it for |
| --- | --- |
| `sqlite` | The default. A real file, queryable, one writer. |
| `file` | A single JSON document. Useful for diffing or for a shared volume. |
| `memory` | Ephemeral. Nothing survives the process — for tests and demos. |

## Propose a rule

An entity starts on **probation**: it is known, but nothing is claimed about it yet.

```sh
medha propose --id no-console-log --source review
```

```
medha: proposed rule/no-console-log (not promoted)
  reason:   Requires >= 2 converging sources; saw 1 (review)
  trust:    0.000  status: probation
```

Note it was *not* promoted. Promotion wants agreement from at least two independent sources, so one
proposal is a candidate rather than a fact. `--source` is how you attribute it; use something stable
and honest (`review`, `ci`, a person or team name).

## Record what happens

This is the part that matters. Every use is evidence.

```sh
medha record --id no-console-log --signal APPLY --ensure    # used, and it worked
medha record --id no-console-log --signal APPLY
medha guard  --id no-console-log --ok --guard review        # a check that the rule still holds
```

```
medha: recorded APPLY on rule/no-console-log
  trust:    0.103  status: probation
medha: recorded APPLY on rule/no-console-log
  trust:    0.171  status: probation
medha: guard passed on rule/no-console-log
  trust:    0.378  status: active
```

Two successes alone would still leave the rule on probation. The **guard** is what let it reach
`active` — usage is not verification, and medha will not pretend otherwise.

There are three built-in signals:

| Signal | Meaning |
| --- | --- |
| `APPLY` | It was used, and it worked. |
| `REJECT_RULE` | A human rejected it. |
| `SKIP` | It did not apply. Neutral: it never counts for or against. |

`--ensure` creates the entity if it does not exist yet. Without it, recording against an unknown id
changes nothing and the response says `recorded: false` — so a typo does not invent an entity. The
attempt is still logged, and `medha show` marks it "no effect", so a mistaken id leaves a trail.

## Ask why

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
  recent episodes:
    #3 guard at 2026-09-28T05:57:31.737Z
    #2 signal at 2026-09-28T05:57:31.623Z
    #1 signal at 2026-09-28T05:57:31.512Z
    #0 proposal at 2026-09-28T05:57:31.388Z
  provenance:
    review
```

`trust` is broken into its components, so you never have to take it on faith. If it is lower than you
expected, the components say which factor is responsible — see
[How trust is computed](/guide/trust).

For the full bar-by-bar reasoning:

```sh
medha explain-threshold --id no-console-log
```

```
medha: thresholds for rule/no-console-log (known)
  trust:    0.378  status: active
  trusted: not met
    no     trust 0.378 >= 0.6
    no     uses 2 >= 5
    ok     guard last check passed: true
  active: MET
    ok     trust 0.378 >= 0.25
  drifting: not met
    no     samples 2 >= 3
    no     |mu - theta0| 0.095 >= 0.4
  note: Medha reports which thresholds clear and why; it never decides for the host.
```

Every bar is listed with `ok` or `no`. The two `no` lines are the reason this rule is `active` and
not yet `trusted`: it needs 5 uses and a trust of 0.6.

## Preview before you commit

Anything consequential, dry-run it first. `simulate` persists nothing:

```sh
medha simulate --id no-console-log --signal REJECT_RULE
```

```
medha: simulate REJECT_RULE on rule/no-console-log
  trust:    0.378 -> 0.229 (delta -0.149)
  status:   active -> probation (changed)
```

## Machine output

Every command takes `--json`:

```sh
medha show --id no-console-log --json
medha list --status probation --json
```

Point at a different engine home with `--home <dir>`, which is how several projects share one store.

## Next

- [Concepts](/guide/concepts) — the vocabulary: entities, signals, guards, episodes, namespaces.
- [How trust is computed](/guide/trust) — what the number means and why it is built this way.
- [Using it from an agent](/guide/mcp) — the MCP server and the nine tools it exposes.
