---
title: Extending medha
description: Register your own kinds and signals, give a kind its own thresholds, weight evidence by signal value, and scaffold a custom weight updater.
---

# Extending medha

The built-in kinds — `rule`, `recipe`, `tool` — are conventions, not a closed set. A linter is not a
recipe, and a house style guide is not a tool. You can register your own kinds, give them their own
thresholds, and define your own signals.

Everything here lives in `.medha/config.json`, which `medha init` writes and which is meant to be
committed: it is small, human-authored, and reviewable in a pull request.

## Register a kind

A kind needs to appear in **two** places. This trips people up, so it is worth stating plainly:

```json
{
  "registries": {
    "kinds": ["rule", "recipe", "tool", "lint"],
    "kindSpecs": [
      { "name": "rule" },
      { "name": "recipe" },
      { "name": "tool" },
      { "name": "lint" }
    ]
  }
}
```

- `kinds` is the **registry** — the name has to exist before it can be addressed.
- `kindSpecs` is the **spec** — the name plus whatever settings that kind wants.

Adding a `kindSpec` without adding the name to `kinds` is silently ineffective, and the error only
shows up when you try to use it:

```
medha : error: Unknown kind 'lint'
(CORE_UNKNOWN_REGISTRY_ENTRY)
```

`medha maintain preflight` is the check. It prints the registry counts, so a kind you added but failed
to register shows up as a mismatch:

```
medha: preflight for /your/project/.medha
  status:     ok
  episodes:   4
  entities:   1
  integrity:  ok
  registries: 4 kinds, 4 signals, 1 anchors
```

## Give a kind its own thresholds

This is the main reason to define your own kind. A linter that runs on every commit accumulates
evidence fast and should reach `trusted` quickly; a house convention that matters twice a year should
not. One set of thresholds cannot serve both.

```json
{
  "name": "lint",
  "thresholds": {
    "active": 0.15,
    "trusted": 0.4,
    "minUsesForTrusted": 3
  },
  "recency": {
    "halfLifeDays": 20,
    "floor": 0.2
  }
}
```

Compared with the defaults, that says: a lint rule becomes useful sooner, becomes trusted at a lower
bar after fewer uses, and loses its edge faster if it stops being checked.

Fields you leave out keep their default, so a spec can be as small as `{ "name": "lint" }`.

::: warning The guard requirement is not a threshold
No threshold override can promote an entity to `trusted` without a passing guard. That is enforced by
the trust ceiling, not by a configurable number — see
[Usage alone never makes a rule trusted](/guide/trust#usage-alone-never-makes-a-rule-trusted). The
guarantee holds for custom kinds too, at any threshold you pick.
:::

## Weight evidence by signal value

By default a signal counts as one success or one failure. `signal-value` weighting instead uses the
signal's own numeric value, which is what you want when outcomes differ in degree:

```json
{ "name": "tool", "evidenceWeighting": "signal-value" }
```

A tool that times out is not the same as a tool that crashes, and counting both as a single failure
throws that away. With `signal-value`, a mild negative weighs less than a severe one. The trade is
that evidence accrues fractionally rather than as whole trials, so read the components in
`medha show` when a score looks unusual.

## Register a signal

Signals live in `signalSpecs`, each with a value and whether it counts as a trial and as a success:

```json
{
  "registries": {
    "signalSpecs": [
      { "name": "APPLY",         "value":  1,   "countsAsTrial": true,  "countsAsSuccess": true },
      { "name": "SKIP",          "value":  0,   "countsAsTrial": false, "countsAsSuccess": false },
      { "name": "REJECT_CONTEXT","value": -0.2, "countsAsTrial": false, "countsAsSuccess": false },
      { "name": "REJECT_RULE",   "value": -1,   "countsAsTrial": true,  "countsAsSuccess": false }
    ]
  }
}
```

That is the built-in set as `medha init` writes it. `REJECT_CONTEXT` is the fourth one — a rejection
that does not indict the entity itself, only the context it was applied in. It is a real signal and
worth knowing about; it is deliberately not a trial, so it cannot count against an entity.

To add your own, append an entry and use it:

```sh
medha record --id no-tabs --signal PARTIAL --kind lint
```

Be deliberate about `countsAsTrial`. Anything that is not a trial contributes no evidence, which is
how `SKIP` and `REJECT_CONTEXT` stay harmless. A signal marked as neither a trial nor a success is
effectively an annotation — still recorded, still auditable, no effect on trust.

## Swap the weight updater

The default updater folds signals into an exponential moving average. If your use case wants
different movement, you can fork it:

```sh
medha updater list                     # what is available
medha updater show <name>              # how one works
medha updater fork <name>              # scaffold a custom one
```

`updater fork` writes a starting point you own, so changing how evidence moves trust does not require
patching the engine.

## A complete example

```json
{
  "layoutVersion": 1,
  "backend": "sqlite",
  "path": "store.sqlite",
  "registries": {
    "kinds": ["rule", "recipe", "tool", "lint", "convention"],
    "anchorKinds": ["week"],
    "kindSpecs": [
      { "name": "rule" },
      { "name": "recipe" },
      { "name": "tool", "evidenceWeighting": "signal-value" },
      { "name": "lint", "thresholds": { "active": 0.15, "trusted": 0.4, "minUsesForTrusted": 3 } },
      { "name": "convention", "thresholds": { "active": 0.3, "trusted": 0.75, "minUsesForTrusted": 8 },
        "recency": { "halfLifeDays": 120 } }
    ],
    "signalSpecs": [
      { "name": "APPLY",          "value":  1,   "countsAsTrial": true,  "countsAsSuccess": true },
      { "name": "SKIP",           "value":  0,   "countsAsTrial": false, "countsAsSuccess": false },
      { "name": "REJECT_CONTEXT", "value": -0.2, "countsAsTrial": false, "countsAsSuccess": false },
      { "name": "REJECT_RULE",    "value": -1,   "countsAsTrial": true,  "countsAsSuccess": false }
    ]
  }
}
```

A `convention` here is deliberately the strictest: a higher bar, more uses, and a much longer recency
half-life, because a house convention is trusted slowly and stays trusted for a long time.

## After editing

```sh
medha maintain preflight    # confirm the registries parsed and the store is intact
medha show --id <id>        # confirm the components look the way you expect
```

Changing a kind's thresholds does not retroactively rewrite history — it changes how the existing
episodes are read from now on. That is intentional, and it is another reason to prefer per-kind
overrides over editing anything global: the change is scoped, reviewable, and reversible.

## Next

- [How trust is computed](/guide/trust) — what the thresholds mean.
- [Maintenance and sharing](/guide/maintenance) — keeping the store healthy over time.
