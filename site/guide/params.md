---
title: Parameters and thresholds
description: Every constant medha uses, what each one controls, and which of them you can override.
---

# Parameters and thresholds

Every constant in the model is readable:

```sh
medha params
```

```
medha: canonical model parameters (read-only)
  note: read-only: model parameters are canonical constants in medha-core — the lean engine has no
        mutable params store
  NAME                          VALUE      SOURCE
  WILSON_Z                        1.960   medha-core: thresholds.ts
  TRUSTED_THRESHOLD               0.600   medha-core: thresholds.ts
  MIN_USES_FOR_TRUSTED            5.000   medha-core: thresholds.ts
  ACTIVE_THRESHOLD                0.250   medha-core: thresholds.ts
  RETIRED_TRUST_THRESHOLD         0.100   medha-core: thresholds.ts
  UNGUARDED_TRUST_CEILING         0.500   medha-core: thresholds.ts
  SKIP_SIGNAL                     0.000   medha-core: thresholds.ts
  RECENCY_HALF_LIFE_DAYS         45.000   medha-core: thresholds.ts
  RECENCY_FLOOR                   0.300   medha-core: thresholds.ts
  DURABILITY_GAIN                 0.150   medha-core: thresholds.ts
  DURABILITY_MAX                  1.500   medha-core: thresholds.ts
  DEFAULT_THETA0                  0.500   medha-core: thresholds.ts
  DEFAULT_EMA_ALPHA               0.100   medha-core: ema.ts
  MIN_SAMPLES_FOR_DRIFT           3.000   medha-core: ema.ts
  DRIFT_THRESHOLD                 0.400   medha-core: ema.ts
  DEFAULT_SWEEP_INTERVAL_MS    86400000.000   medha: maintenance.ts
  DEFAULT_FOLD_DAYS              90.000   medha: maintenance.ts
  DEFAULT_RETENTION_DAYS         90.000   medha: maintenance.ts
```

## What each one controls

### Evidence

| Name | Value | Effect |
| --- | --- | --- |
| `WILSON_Z` | 1.96 | Confidence quantile for the Wilson lower bound. Higher is more conservative. |
| `SKIP_SIGNAL` | 0.0 | The value of `SKIP`. It is 0 by design: neutral, and it never counts as a trial. |

### Lifecycle thresholds

| Name | Value | Effect |
| --- | --- | --- |
| `ACTIVE_THRESHOLD` | 0.25 | Trust needed to be `active`. |
| `TRUSTED_THRESHOLD` | 0.6 | Trust needed to be `trusted`. |
| `MIN_USES_FOR_TRUSTED` | 5 | Uses needed alongside the trust bar. |
| `UNGUARDED_TRUST_CEILING` | 0.5 | Hard cap on trust with no passing guard. |
| `RETIRED_TRUST_THRESHOLD` | 0.1 | Sustained trust below which an entity retires. |
| `MIN_USES_FOR_RETIRED` | 3 | Uses needed before retirement by trust. |

### Recency

| Name | Value | Effect |
| --- | --- | --- |
| `RECENCY_HALF_LIFE_DAYS` | 45 | How fast evidence fades. |
| `RECENCY_FLOOR` | 0.3 | How far it can decay. Trust fades, it does not vanish. |

### Durability

| Name | Value | Effect |
| --- | --- | --- |
| `DURABILITY_GAIN` | 0.15 | Bonus rate per distinct checkpoint of held-up evidence. |
| `DURABILITY_MAX` | 1.5 | Ceiling on that bonus. |

### Drift

| Name | Value | Effect |
| --- | --- | --- |
| `DEFAULT_THETA0` | 0.5 | Starting baseline a fresh entity is compared against. |
| `DEFAULT_EMA_ALPHA` | 0.1 | Smoothing for the moving average. Lower reacts more slowly. |
| `MIN_SAMPLES_FOR_DRIFT` | 3 | Samples required before drift can be flagged. |
| `DRIFT_THRESHOLD` | 0.4 | How far from baseline counts as drifting. |

### Maintenance

| Name | Value | Effect |
| --- | --- | --- |
| `DEFAULT_SWEEP_INTERVAL_MS` | 86 400 000 | How often the background sweep runs (24 h). |
| `DEFAULT_FOLD_DAYS` | 90 | Age at which compaction folds episodes into baselines. |
| `DEFAULT_RETENTION_DAYS` | 90 | How long folded history is kept. |

## Why they are read-only

`medha params` reports them from the engine rather than from a settings file, and there is no way to
write them back. That is intentional: the numbers that decide what your agents trust should not drift
as a side effect of an unrelated change, and two projects sharing a store should not disagree about
what `trusted` means.

The knob is not "make medha less strict" — it is **per-kind**. A linter and a house style guide do not
deserve the same bar, and the model already accounts for that.

## Overriding per kind

Each kind in `.medha/config.json` can carry its own `thresholds` and `recency`. Anything you leave out
keeps the default above. See [Extending medha](/guide/extending) for a worked example.

Two rules to keep in mind:

- **The guard requirement is not a threshold.** No override can promote an entity to `trusted` without
  a passing guard — that is enforced by the ceiling, not configurable.
- **Overrides are per kind, and visible.** `medha show` reports the components that produced a score,
  so an unexpected trust value under a custom kind is traceable rather than mysterious.

## Reading a value in context

A threshold on its own means little; what matters is the margin. Two commands answer that:

```sh
medha show --id no-console-log            # components, evidence, and which bars clear
medha explain-threshold --id no-console-log  # each bar, ok or no, with actual vs expected
```

`explain-threshold` is the one to reach for when an entity is not where you expected. It prints every
condition, not just the failing summary — so you can see the difference between "needs 3 more uses" and
"trust is 0.19 short".
