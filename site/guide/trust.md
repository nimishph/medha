---
title: How trust is computed
description: What the trust number means, what each component does, and why medha is built to be pessimistic.
---

# How trust is computed

Trust is a single number in `[0, 1]`. This page explains what it means, how it is built, and why
each part is the way it is. If you only read one section, read [The five components](#the-five-components)
and [Why so pessimistic](#why-so-pessimistic).

If you want the reasoning behind a specific number rather than the design, use the tool: `medha show`
prints every component, and `medha explain-threshold` prints every bar with the actual and expected
values. Nothing about a trust score is hidden.

## The shape of the answer

```
trust = min( ceiling,  wilson × recency × durability × guard )
```

Four factors multiply, and a ceiling clamps the result. Every factor is visible in `medha show`:

```
  trust:    0.378  (wilson 0.342, guard 1.000, recency 1.000, durability 1.104, ceiling 1.000)
```

Read as a sentence: *how well it has done* (wilson) × *how recently that was true* (recency) × *how
long it has held up* (durability) × *whether anyone has verified it* (guard), and never above what an
unverified entity is allowed to reach (ceiling).

Multiplication is the point. Trust is a conjunction, not an average: an entity with an excellent
success rate that nobody has checked in a year is not trusted, and an entity checked constantly but
failing half the time is not trusted. Every factor has to be sound.

Here is the same arithmetic from a real session, using the exact values medha printed:

| Factor | Value |
| --- | --- |
| wilson | 0.342372 |
| guard | 1 |
| recency | 0.999989 |
| durability | 1.103972 |
| ceiling | 1 |

```
0.342372 × 0.999989 × 1.103972 = 0.377965   →   trust 0.378
```

## The five components

### Wilson lower bound — *how well it has actually done*

A conservative estimate of the true success rate given `k` successes in `n` trials.

The obvious alternative is the raw ratio, `k / n`, and it is the wrong choice. A ratio is maximally
optimistic exactly where you know least: 1 out of 1 is a perfect 1.0, so a rule that worked once
yesterday would outrank one that worked 380 times out of 400. The Wilson lower bound fixes this by
accounting for sample size — 1/1 scores about 0.21, while 380/400 scores about 0.87.

The other important property: **zero trials scores 0**. No evidence means no claim. Medha does not
substitute a flattering prior for an entity nobody has ever used.

### Guard — *whether anyone has verified it*

The outcome of the most recent guard report, as a multiplier. A guard that has passed scales by 1; one
that has never been reported scales by less than 1; one that has failed scales trust to 0.

This is the component that makes the whole system honest. See
[The guard cap](#usage-alone-never-makes-a-rule-trusted) below.

### Recency — *how recently that was true*

Evidence decays with a 45-day half-life, down to a floor, so a rule that was reliably true two years
ago scores lower than one that was reliably true last month. Old wins fade.

The floor matters as much as the decay. Trust is not allowed to decay to nothing — an entity that was
genuinely good and simply went quiet should stay moderately trusted rather than being erased. Time
should lower a score, not zero it. For the same reason age never *retires* an entity: retirement
needs repeated evidence of failure, so a rule with one old success and nothing since stays on
probation with a faded score.

### Durability — *how long it has held up*

A bonus, up to 1.5×, for evidence that has held up across distinct checkpoints over time. The same
success recorded repeatedly in one afternoon proves less than the same success spread across many
separate occasions. Durability rewards the second kind.

Only guarded entities earn it, and only for evidence that was actually verified. An entity nobody has
ever checked has nothing durable to show, so the factor stays at 1 — it can neither earn nor lose.

### Ceiling — *what an unverified entity is allowed to reach*

A hard cap on trust for any entity that has never had a passing guard. It exists so that
[usage alone can never promote a rule](#usage-alone-never-makes-a-rule-trusted).

The ceiling is a clamp, not another multiplier, which is what makes it a guarantee: no combination of
usage, history or age can push an unverified entity past it, however good its other numbers look.

## Usage alone never makes a rule trusted

This is the single most important property, and it is enforced in two independent places.

1. **The guard factor** scales trust down whenever no guard has passed.
2. **The ceiling** caps it at 0.5 — and the bar for `trusted` is 0.6.

So an unverified entity cannot reach `trusted` even in principle. It can climb to `active` and stop
there. There is no combination of signals that gets past it.

The reasoning is straightforward. An entity that has been applied a hundred times and never once
checked is evidence of *habit*, not evidence of *correctness*. Plenty of wrong things get followed
religiously. What makes a rule worth trusting is not that it is obeyed, but that something
independent has confirmed it — a test, a linter, a reviewer.

The `trusted` gate reflects this. It needs three things, all of them:

| Condition | Why |
| --- | --- |
| trust ≥ 0.6 | The performance bar. |
| at least 5 uses | Enough evidence for the estimate to mean anything. |
| a passing guard | The entity has been independently verified. |

`medha explain-threshold` shows exactly which conditions are outstanding:

```
  trusted: not met
    no     trust 0.378 >= 0.6
    no     uses 2 >= 5
    ok     guard last check passed: true
```

## Drift: watching for a change in behaviour

Trust measures how an entity has done overall. **Drift** measures whether its *recent* behaviour has
started to diverge from its own baseline — the rule that used to be applied reliably and is now
getting rejected.

An exponential moving average tracks recent signal values, and drift is flagged when that average
moves far enough from the entity's starting baseline. It needs at least 3 samples before it will
report anything, because a single signal is not a trend.

Drift and trust are complementary, and drift can catch you earlier. A rule's lifetime success rate
can still look healthy while its last five applications were all rejections. Trust degrades slowly;
drift notices immediately. `medha drift` lists drifting entities most-drifted first, in either
direction.

Only drift **downward** quarantines. An entity whose recent behaviour is *better* than its baseline
— a run of straight successes walks the average up past the threshold within about 16 signals — is
reported as drifting but keeps its status: out-performing the prior is evidence for trust, not
against it.

## Everything is derived, nothing is asserted

Entity state is a **fold** over an append-only episode log — a pure function of what has been
recorded. Nothing writes a trust value; the number falls out of the history.

This has a practical consequence worth leaning on: **you can always ask why, and you can always
correct it.** Because state is recomputed rather than stored, a mistaken record is fixable without
hand-editing a score:

```sh
medha retract --seq 12 --reason "recorded against the wrong entity"
```

The episode is masked, the state is recomputed from the log, and the correction is itself part of the
record. `medha remove-episode` is the heavier tool: it drops the entry from the log and rebuilds the
projection. Either way the trust you see is reproducible from the episodes behind it.

## Why so pessimistic

A deliberate design choice runs through all of this: **medha is built to be hard to convince.**

- No evidence scores 0, not a neutral prior.
- Small samples score low, so nothing is proven by a lucky first run.
- Unverified entities are capped, so volume cannot substitute for correctness.
- Time lowers trust, so staleness is visible.
- Drift can quarantine an entity while its overall score still looks fine.

A memory system that is quick to believe will confidently recommend a stale rule for months. The cost
of medha being conservative is that a good rule takes a little evidence to reach `active` — visible in
every `medha record` line as trust climbing gradually. The benefit is that when it says an entity is
`trusted`, that means something: it was applied, it worked, it was checked, and it was checked
recently.

If that is the wrong trade for your use, two things are tunable without forking: per-kind thresholds
and recency, via [Extending medha](/guide/extending), and the weight updater.

## The parameters

Every constant is readable, and none of them are secret:

```sh
medha params
```

```
medha: canonical model parameters (read-only)
  NAME                          VALUE      SOURCE
  WILSON_Z                        1.960   ...
  TRUSTED_THRESHOLD               0.600   ...
  MIN_USES_FOR_TRUSTED            5.000   ...
  ACTIVE_THRESHOLD                0.250   ...
  RETIRED_TRUST_THRESHOLD         0.100   ...
  UNGUARDED_TRUST_CEILING         0.500   ...
  RECENCY_HALF_LIFE_DAYS         45.000   ...
  RECENCY_FLOOR                   0.300   ...
  DURABILITY_GAIN                 0.150   ...
  DURABILITY_MAX                  1.500   ...
  DEFAULT_THETA0                  0.500   ...
  DEFAULT_EMA_ALPHA               0.100   ...
  MIN_SAMPLES_FOR_DRIFT           3.000   ...
  DRIFT_THRESHOLD                 0.400   ...
```

They are deliberately read-only: the numbers that decide what your agents trust should not be
editable as a side effect of some other change. To tune them, see
[Extending medha](/guide/extending) — per-kind overrides go in `.medha/config.json`, where the
intent is explicit and reviewable.

## Next

- [Using it from an agent](/guide/mcp) — feeding these hints to an agent.
- [Extending medha](/guide/extending) — custom kinds, signals, and thresholds.
- [Parameters and thresholds](/guide/params) — the full table with what each one controls.
