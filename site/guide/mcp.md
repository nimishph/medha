---
title: Using it from an agent
description: Register the medha MCP server, use the twelve tools from an agent, and fit trust hints into a prompt.
---

# Using it from an agent

The CLI is for you. The MCP server is for your agent â€” same engine, same store, same numbers, exposed
as tools instead of commands.

## Register the server

```json
{ "mcpServers": { "medha": { "command": "medha", "args": ["mcp", "serve"] } } }
```

That is the whole setup. There is no daemon, no port and no background process: the server runs on
stdio inside the host, reading the engine home in the working directory like any other command.

Then copy the [agent skill](/agent-skill) to `.claude/skills/medha/SKILL.md` so the agent knows when
and how to reach for it. The skill is a short workflow â€” read hints, propose, record, report guards â€”
and it is the difference between an agent that uses medha deliberately and one that never calls it.

## The tools

| Tool | Purpose |
| --- | --- |
| `hints` | Batch-fetch trust hints for keys you are about to rely on. Returns `{ hints, unknown }`. |
| `list_entities` | List entities with trust, status and drift flags, filtered and paginated. |
| `show_entity` | Full detail: trust, components, temporal state, recent episodes, provenance. |
| `record_signal` | Record `APPLY`, `REJECT_RULE`, `SKIP` and so on. |
| `report_guard` | Record a guard result (a harness pass/fail, a review verdict). |
| `propose` | Submit a candidate entity. |
| `drift` | List drifting entities, most-drifted first. |
| `simulate` | Preview a signal's effect. Persists nothing. |
| `status` | Engine health: preflight integrity, status distribution, drift count. |
| `retract_episode` | Retract an erroneous episode by sequence number, appending a masking episode. |
| `remove_episode` | Physically remove an episode from the log and resequence the rest. |
| `pack_context` | Pack active and probation entities into a context window within a token budget. |

## The loop that matters

The four calls that make up a working session, in the order you want them:

1. **`hints`** â€” before relying on anything, ask what is already known. Do not skip this; it is the
   entire point of the tool.
2. **`propose`** â€” when you meet a rule worth keeping, submit it. It enters on probation.
3. **`record_signal`** â€” as things actually happen. `APPLY` when you used it and it worked,
   `REJECT_RULE` when a human rejected it, `SKIP` when it did not apply.
4. **`report_guard`** â€” when an independent check ran, report the outcome. This is what eventually
   lets something become `trusted`.

The failure mode to avoid is step 3 without step 4. Signals alone will never get an entity past
`active`, by design â€” so an agent that diligently records applies but never reports guards will build
a store full of `active` entities and wonder why nothing is ever `trusted`.

## `recorded: false` is not an error

`record_signal` returns `recorded: false` when the entity is unknown and `ensure` was not set. Nothing
was written.

This is deliberate: a typo'd id should not silently invent an entity and start accumulating evidence
against it. If you genuinely mean to create it, pass `ensure: true`. If you did not mean to, the
no-op is telling you something â€” most likely that the id you are using is not the one the guidance was
recorded under.

## Treat `unknown` as probation

`hints` deliberately separates what it knows from what you asked about:

```json
{ "hints": { "rule/no-console-log": { "trustScore": 0.378, "status": "active" } },
  "unknown": ["rule/a-rule-nobody-has-seen"] }
```

`unknown` is not an error and not an endorsement. It means medha has no evidence about that key, which
makes it exactly as trustworthy as a brand-new entity: **probation**. Handle it that way â€” mention the
guidance if it seems reasonable, but do not treat it as established.

## Fitting trust into a prompt

The hard part of agent memory is not storing guidance, it is staying inside the context window. Pass
a token budget and medha selects the most trusted entities that fit:

```sh
medha pack --budget 2000
```

`pack_context` exposes the same thing over MCP. It prefers the better-evidenced entities, so a fixed
budget buys you the guidance most worth having rather than an arbitrary slice.

## Corrections

Agents get things wrong, and the log is designed for that. When an agent records something it should
not have:

```sh
medha retract --seq 12 --reason "recorded against the wrong entity"
```

Over MCP that is `retract_episode`. The episode is masked, state is recomputed from the log, and the
correction is recorded. Because entity state is a fold over an append-only log, this always works â€”
there is no denormalized score to repair by hand.

Use `remove_episode` when the entry should not exist at all, rather than merely be inactive.

## What medha will not do

It reports evidence and returns hints. It does not decide.

There is no tool that says "apply this rule because its trust is high", and there is no automatic
promotion, no pruning of low-trust entities, and no silent rewriting of your guidance. A high trust
score is a well-supported claim, not an instruction â€” the decision stays with you and your agent, and
that separation is the point.

## Next

- [Concepts](/guide/concepts) â€” the vocabulary behind these tools.
- [Extending medha](/guide/extending) â€” custom kinds, signals and thresholds.
- [CLI reference](/cli) â€” the same engine from the command line.
