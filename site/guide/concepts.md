---
title: Concepts
description: The vocabulary of medha — entities, kinds, namespaces, signals, guards, episodes, trust, and the lifecycle.
---

# Concepts

Six ideas carry the whole system. Once these are straight, every command and every number makes
sense.

## Entity

The thing being trusted. An entity is addressed by three coordinates:

| Coordinate | Default | Notes |
| --- | --- | --- |
| `namespace` | empty | Lets one store hold several unrelated projects without collisions. |
| `kind` | `rule` | What sort of thing it is. Built-ins: `rule`, `recipe`, `tool`. You can register your own. |
| `id` | — | Opaque to medha. Unique within a namespace + kind. |

So `rule/no-console-log` in the default namespace is a rule whose id is `no-console-log`. You can
register your own kinds with their own thresholds — see [Extending medha](/guide/extending).

Every entity has a **status** and a **trust** value. Both are *derived*; neither is stored as an
opinion you have to maintain.

## Signal

One piece of evidence about an entity: something happened to it.

| Signal | Meaning | Counts as a trial? |
| --- | --- | --- |
| `APPLY` | It was used, and it worked. | yes, a success |
| `REJECT_RULE` | A human rejected it. | yes, a failure |
| `SKIP` | It did not apply. | no — neutral |

`SKIP` is deliberately inert. It neither helps nor hurts, and — importantly — it does not refresh
recency either. A rule that nobody has needed in six months should *look* six months stale, not look
freshly validated because an agent kept declining to use it.

You can register your own signals, and a kind can weight a signal's value rather than counting it as
one success or one failure — see [Extending medha](/guide/extending).

## Guard

An independent check that the entity is still correct: a test, a linter run, a code review, a human
reading it. You report the outcome with `medha guard --ok` or `--fail`.

A guard is the difference between "used a lot" and "verified". Its effect on trust is the single most
important thing to understand:

> **Usage alone can never make an entity `trusted`.** Without a passing guard, trust is capped at 0.5
> — below the 0.6 bar for `trusted`. A rule nobody ever checks can become `active`, and that is as
> far as it goes.

This is deliberate. An entity that is applied ten thousand times and never verified is not evidence of
correctness; it is evidence of habit.

## Episode

Every proposal, signal and guard result is written to an **append-only log** as an immutable episode.
Entity state is a *fold* over that log — a pure function of the entries.

```
episodes (append-only)  ──fold──▶  entity state  ──▶  trust + status
        ▲
        └── nothing is ever overwritten
```

Because state is derived rather than stored, it can always be rebuilt. If something bad gets
recorded, you do not have to hand-edit a score:

```sh
medha retract --seq 12 --reason "recorded against the wrong entity"
```

The episode is masked and the state recomputed from the log. `medha remove-episode` is the blunter
tool: it drops the entry from the log entirely and rebuilds the projection. Both are auditable —
the correction is itself recorded.

## Trust

A single number in `[0, 1]` summarizing how well an entity has actually performed. It is built from
five components and is always inspectable:

```
trust = min( ceiling,  wilson × recency × durability × guard )
```

[How trust is computed](/guide/trust) walks through each one.

Two properties are worth internalising:

- **It is earned, not asserted.** A new entity has trust `0.000`. Nothing anyone writes down can set
  it directly.
- **It is conservative about small samples.** Trust uses a Wilson lower bound, so 2 successes out of
  2 scores far lower than 200 out of 200. A brand-new rule does not get to look proven.

## Lifecycle

Status is a function of trust, evidence and guard state — not something you set.

```
probation ──► active ──► trusted
    │            │
    └────────────┴──► quarantined / retired
```

| Status | What it takes |
| --- | --- |
| `probation` | Seen, but not yet enough evidence to be useful. Where everything starts. |
| `active` | trust ≥ 0.25 |
| `trusted` | trust ≥ 0.6, **at least 5 uses**, and a passing guard |
| `quarantined` | A guard failed, or the entity is drifting away from its own baseline. |
| `retired` | Repeatedly rejected, or trust sustained below 0.1 over enough uses. |

Drift down the graph is a normal outcome, not an error: a rule that used to be applied reliably and
now gets rejected is a rule that has stopped being true, and medha would rather say so than keep
recommending it.

`medha list` and `medha drift` let you find these:

```sh
medha list --status quarantined
medha drift
```

## Reading a hint

When an agent asks what to trust, `hints` returns two buckets:

```json
{ "hints": { "rule/no-console-log": { "trust": 0.378, "status": "active" } },
  "unknown": ["rule/some-new-thing"] }
```

The `unknown` bucket is the one to handle deliberately. An unknown id is an entity medha has never
seen, which means it is on probation as far as the agent is concerned — not that it is safe. Treating
`unknown` as probation is the correct default, and it is why `hints` returns it separately instead of
silently omitting it.

## Where to go next

- [How trust is computed](/guide/trust) — the five components in detail.
- [Using it from an agent](/guide/mcp) — the MCP tools and how to wire them into a host.
- [Maintenance and sharing](/guide/maintenance) — compaction, backup, and multi-machine sync.
