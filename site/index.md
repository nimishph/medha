---
layout: home
title: medha
titleTemplate: Evidential memory for rules, recipes and tools
hero:
  name: medha
  text: Memory that remembers what happened
  tagline: >-
    Agents accumulate rules, recipes and tools. Some help. Some are stale, wrong, or quietly ignored.
    medha records what actually happened and returns a trust hint — it reports evidence and never
    decides for you.
  image:
    src: /logo.svg
    alt: medha
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: How trust is computed
      link: /guide/trust
    - theme: alt
      text: CLI reference
      link: /generated/cli

features:
  - title: Earned, not asserted
    details: >-
      A new rule starts on probation. Usage alone never makes it trusted — a passing guard is
      required, so trust always reflects verification, not volume.
  - title: Honest about small samples
    details: >-
      Trust uses a Wilson lower bound, so two successes out of two is not scored like 200 out of
      200. An entity with no evidence scores zero, not an optimistic prior.
  - title: Explainable
    details: >-
      Every number can be traced. medha show splits trust into its components, and
      explain-threshold names each bar that was cleared and each one that was not.
  - title: Safe to try
    details: >-
      simulate previews what a signal would do and persists nothing, so you can think before you
      record something consequential.
  - title: One binary, no server
    details: >-
      CLI and MCP server in a single self-contained executable. State is an append-only episode log
      you can back up, compact, sync, or replay.
  - title: Nothing is lost
    details: >-
      Nothing is overwritten. A wrong entry can be retracted and the entity state recomputed from
      the log, so the record always stays auditable.
---

## What it is for

An agent accumulates guidance: "never leave a `console.log` in a commit", "run migrations this
way", "prefer the linter over the formatter". Most memory systems store *what was said* and treat all
of it as equally true. Medha stores *what happened* — every apply, every human rejection, every skip,
every guard result — and folds that history into a trust hint you can read, explain, and audit.

```sh
npm install -g @cntxt-labs/medha-cli
medha init
medha propose --id no-console-log --source review
medha record  --id no-console-log --signal APPLY --ensure
medha guard   --id no-console-log --ok --guard review
medha show    --id no-console-log
```

<div class="home-links">
  <a href="/guide/getting-started">Install and run your first session →</a>
</div>

## The idea in one paragraph

An **entity** is something you might come to rely on — a rule, a recipe, a tool — addressed by a
namespace, a kind, and an id. Every time something happens to it you **record a signal**: it was
applied and worked, a human rejected it, or it simply did not apply. A **guard** is an independent
check that it is still correct. From that history medha computes a single number, **trust**, and a
**status**: `probation`, `active`, `trusted`, `quarantined` or `retired`. Those are *hints*. Your
agent — or you — decide what to do next. Read [Concepts](/guide/concepts) for the vocabulary and
[How trust is computed](/guide/trust) for what the number means.
