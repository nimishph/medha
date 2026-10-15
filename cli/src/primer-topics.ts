/**
 * The primer's text, the one source both CLIs render (medha-v1g). Every number that the trust
 * model decides is a `{{NAME}}` placeholder, filled from the kernel's own constants at render
 * time, so the primer cannot drift from the engine again: it used to say "active at L >= 0.50,
 * ceiling 0.85" while the engine used trust 0.25 and a 0.5 ceiling (gh-19).
 *
 * `tooling/sync-plugin.ts` copies these templates to `crates/medha-cli/src/primer_topics.json` for
 * the Rust CLI, and `tooling/plugin.test.ts` fails when that copy is stale. The placeholders each
 * CLI fills are listed in `PRIMER_PLACEHOLDERS` (here) and `primer_values` (Rust).
 */

export interface PrimerTemplate {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly template: string;
}

/** Every placeholder a template may use; `primer.test.ts` checks both directions. */
export const PRIMER_PLACEHOLDERS = [
  'ACTIVE_THRESHOLD',
  'TRUSTED_THRESHOLD',
  'MIN_USES_FOR_TRUSTED',
  'UNGUARDED_TRUST_CEILING',
  'RETIRED_TRUST_THRESHOLD',
  'MIN_USES_FOR_RETIRED',
  'DRIFT_THRESHOLD',
  'MIN_SAMPLES_FOR_DRIFT',
  'DEFAULT_EMA_ALPHA',
  'DEFAULT_THETA0',
  'RECENCY_HALF_LIFE_DAYS',
  'RECENCY_FLOOR',
  'DURABILITY_MAX',
  'WILSON_Z',
  'L_2_OF_2',
  'L_200_OF_200',
  'G_PASSED',
  'G_UNVERIFIED',
  'G_NONE',
  'G_FAILED',
  'APPLY_VALUE',
  'REJECT_RULE_VALUE',
  'SKIP_VALUE',
  'REJECT_CONTEXT_VALUE',
] as const;

export type PrimerPlaceholder = (typeof PRIMER_PLACEHOLDERS)[number];

export const PRIMER_TEMPLATES: readonly PrimerTemplate[] = [
  {
    name: 'overview',
    title: 'Medha: Evidential Memory Overview',
    description: 'What Medha is, core philosophy, and essential command cheatsheet.',
    template: `# Medha: Evidential Memory Engine

Medha tracks real-world outcomes for rules, recipes, and tools, returning calibrated **trust hints**.
Core philosophy: **Medha records evidence; you decide what to do with it.**

### Essential Commands
- \`medha init\` — Initialize \`.medha/\` home directory with configuration and store.
- \`medha show --id <id> [--kind <kind>]\` — Inspect trust breakdown (Wilson, guard, recency, durability).
- \`medha record --id <id> --signal <signal>\` — Record an observed signal (e.g. APPLY, REJECT_RULE; \`--ensure\` creates a new entity).
- \`medha guard --id <id> --ok|--fail --guard <kind>\` — Record automated verification outcome.
- \`medha propose --id <id> --source <source>\` — Propose a candidate entity (enters on probation).
- \`medha define --id <id> --title <title> --rationale <why>\` — Define an entity (\`medha decision\` grows its tree).
- \`medha drift\` — Detect upward or downward divergence in entity reliability.
- \`medha pack --budget <tokens>\` — Fit the trusted, active and probation entities into a token budget.
- \`medha sync status|pull|push\` — Synchronize memory across git refs or shared files.
- \`medha ui\` — Launch local real-time web dashboard.
- \`medha primer [topic]\` — Read token-frugal agent guidance on a specific topic.
- \`medha issue [title]\` — Prepare prefilled GitHub issue with sanitized diagnostics.
- \`medha mcp config <client> --write\` — Register the MCP server with a client (\`--list\` for ids).
- Documentation: [nimishph.github.io/medha](https://nimishph.github.io/medha/) (or \`bun run docs:dev\` locally).`,
  },
  {
    name: 'mental-model',
    title: 'The Dual-Loop Architecture & Lifecycle',
    description: 'Fast inner loop vs slow outer loop, and lifecycle status progression.',
    template: `# The Dual-Loop Architecture

Medha decouples real-time reasoning from background evidence calibration:

\`\`\`text
  FAST INNER LOOP: Agent Task -> Query Hints -> Decision -> Apply Rule
                                                               |
  SLOW OUTER LOOP: Calibrated Status <- Trust Engine <- Record Evidence
\`\`\`

1. **Fast Inner Loop (Execution)**:
   - Query \`hints\` or \`medha show\` before applying rules or tools.
   - Inject \`trusted\` items into system prompts; treat \`probation\` with skepticism.
2. **Slow Outer Loop (Evidence)**:
   - When actions succeed or fail, report ground truth (\`APPLY\`, \`REJECT_RULE\`, \`guard\`).
   - Evidential engine continuously refolds the append-only log into entity states.

### Entity Lifecycle Statuses
Trust is T = min(ceiling, L × G × R × D): the Wilson bound, guard, recency and durability factors.
- **Probation**: where every entity starts, and stays while T < {{ACTIVE_THRESHOLD}}.
- **Active**: T ≥ {{ACTIVE_THRESHOLD}}. Without a passing guard, T stays below {{UNGUARDED_TRUST_CEILING}}.
- **Trusted**: T ≥ {{TRUSTED_THRESHOLD}}, at least {{MIN_USES_FOR_TRUSTED}} trials, and a passing guard. Usage alone never gets here.
- **Quarantined**: a guard failed, or the learned weight fell {{DRIFT_THRESHOLD}} or more below its baseline. Trust reads 0. It is a pause, not a verdict: it lifts when the cause clears.
- **Retired**: at least {{MIN_USES_FOR_RETIRED}} trials with the undecayed L × G below {{RETIRED_TRUST_THRESHOLD}}, or an explicit retire. Retirement latches: new evidence never lifts it (an agent cannot talk a rule back in); only a human does, with \`medha reinstate --reason\` or by retracting the failures. Age alone never retires.`,
  },
  {
    name: 'signals',
    title: 'Signals & Evidence Accrual',
    description: 'Built-in signals, trial vs success counts, weights, and author caps.',
    template: `# Signals & Evidence

Evidence is recorded as immutable episodes in an append-only log.

### Built-in Canonical Signals
- **\`APPLY\`** (value: \`{{APPLY_VALUE}}\`, trial: \`true\`, success: \`true\`):
  The rule, recipe, or tool was applied and achieved the desired outcome.
- **\`REJECT_RULE\`** (value: \`{{REJECT_RULE_VALUE}}\`, trial: \`true\`, success: \`false\`):
  A human or test rejected the rule as incorrect, counterproductive, or harmful.
- **\`SKIP\`** (value: \`{{SKIP_VALUE}}\`, trial: \`false\`, success: \`false\`):
  Not applicable to the current context. Neutral observation; does NOT penalize trust.
- **\`REJECT_CONTEXT\`** (value: \`{{REJECT_CONTEXT_VALUE}}\`, trial: \`false\`, success: \`false\`):
  Right in principle, wrong here. Not a trial, so the Wilson bound is untouched; it nudges the weight down.

### Usage
\`\`\`sh
medha record --id no-any-type --signal APPLY --ensure --author "agent-claude" --note "Clean build"
medha record --id old-polyfill --signal REJECT_RULE --author "nimish" --note "Deprecated in Node 20"
\`\`\`

### Author Diversity & Rate Limits (per kind, opt-in)
- \`signalLimits.maxSuccessesPerAuthor\` caps how many successes one author can count.
- \`signalLimits.minIntervalMs\` suppresses a success that follows the same author's last one too soon.
- Failures are never limited. \`thresholds.minDistinctAuthorsForRetired\` stops one author retiring a rule alone.`,
  },
  {
    name: 'guards',
    title: 'Automated Guards & The Unguarded Ceiling',
    description: 'Independent verification, guard factors, and elevating past probation.',
    template: `# Automated Guards & The Unguarded Ceiling

Usage frequency alone cannot prove correctness: a bad rule used 100 times is still bad.
Guards provide external, objective validation (e.g. test suites, linters, AST checks).

### The Unguarded Ceiling Invariant
- **Ceiling**: an entity with no guard stays strictly below **{{UNGUARDED_TRUST_CEILING}}** trust.
- No amount of positive \`APPLY\` signals can make an entity \`Trusted\` without a passing guard.
- A passing guard lifts the ceiling, allowing elevation to \`Trusted\`.

### Recording Guards
\`\`\`sh
# Automated test suite passed
medha guard --id strict-typing --ok --guard harness --note "tsc --noEmit exit 0"

# Automated test suite failed
medha guard --id strict-typing --fail --guard harness --note "tsc reported 3 type errors"
\`\`\`
\`--guard\` names the check. It is required until the entity has a guard; after that it defaults to it.

### Guard Factor (G)
- Passed: G = {{G_PASSED}}.
- Declared but never reported: G = {{G_UNVERIFIED}}.
- No guard: G = {{G_NONE}}, and the {{UNGUARDED_TRUST_CEILING}} ceiling applies.
- Failed: G = {{G_FAILED}}, and the entity is quarantined until a guard passes.`,
  },
  {
    name: 'decisions',
    title: 'Entity Definitions & Decision Trees',
    description: 'Per-branch evidence, conditions, and human approval gating.',
    template: `# Entity Definitions & Decision Trees

Medha supports contextual decision trees so rules can have branch-specific trust.

### Defining an Entity
\`\`\`sh
medha define --id small-db-pool --title "Keep the Postgres pool small" --rationale "Short-lived workers exhaust max_connections"
\`\`\`

### Adding Decision Branches
\`\`\`sh
# Branch 1: high-concurrency serverless, so the rule applies
medha decision --id small-db-pool --condition "environment == 'lambda'" --apply

# Branch 2: long-running container, so it does not
medha decision --id small-db-pool --condition "environment == 'container'" --ignore
\`\`\`

### Per-Branch Evidence
Signal episodes can target specific branch cases via \`--case-id <id>\`:
\`\`\`sh
medha record --id small-db-pool --signal APPLY --case-id case-8f2a1 --note "Lambda stable"
\`\`\`
Evidence on one branch does not contaminate another branch.

### Human Approval Gating (\`requireHumanFor\`)
A kind can require a human to grant branches of given decision types (\`apply\`, \`ignore\`, \`probability\`):
\`\`\`json
"decisionPolicy": {
  "requireHumanFor": ["apply"]
}
\`\`\`
\`human:\` is a label the caller sets, not verification: if refused, escalate to a human.`,
  },
  {
    name: 'drift',
    title: 'Drift Detection & The Wilson Lower Bound',
    description: 'Statistical drift, EMA tracking, and small-sample confidence.',
    template: `# Drift Detection & Wilson Confidence

### Wilson Score 95% Lower Bound (L)
L is the lower end of the Wilson score interval on k successes in n trials (z = {{WILSON_Z}}):
- 2/2 successes gives L ≈ {{L_2_OF_2}}.
- 200/200 successes gives L ≈ {{L_200_OF_200}}.
Small samples score low: two wins are not two hundred.

### Directional Drift
Each signal moves an EMA weight (alpha {{DEFAULT_EMA_ALPHA}}) from the author's baseline θ0
(default {{DEFAULT_THETA0}}). Drift is a move of {{DRIFT_THRESHOLD}} or more, after {{MIN_SAMPLES_FOR_DRIFT}} trials:
\`\`\`sh
medha drift
medha drift --limit 10 --json
\`\`\`

- **Downward Drift**: the weight fell below the baseline. The entity is quarantined automatically.
- **Upward Drift**: the weight rose above the baseline: it is out-performing its prior. Reported, never quarantined.

### Recency
Evidence fades with a {{RECENCY_HALF_LIFE_DAYS}}-day half-life, never below {{RECENCY_FLOOR}}; durability
across distinct anchors adds up to {{DURABILITY_MAX}}×.`,
  },
  {
    name: 'config',
    title: 'Configuration, Schemas & Backends',
    description: '.medha/config.json structure, storage options, and namespace scoping.',
    template: `# Configuration & Storage

Stored in \`.medha/config.json\`, validated against JSON Schema Draft 2020-12.

### Storage Backends
1. **\`sqlite\` (Default & Recommended)**:
   - High-performance WAL mode store at \`.medha/store.sqlite\`.
   - Sub-millisecond queries, atomic transactions, supports 100k+ entities.
2. **\`file\`**:
   - Human-readable append-only JSONL document at \`.medha/state.jsonl\`.
   - Git-friendly and easily audited in diffs.
3. **\`memory\`**:
   - Ephemeral in-process store for unit tests and sandboxes.

### IDE Schema Integration
Include \`$schema\` in \`.medha/config.json\` for autocomplete and hover tooltips:
\`\`\`json
{
  "$schema": "https://raw.githubusercontent.com/nimishph/medha/main/schemas/config.v1.json",
  "layoutVersion": 1,
  "backend": "sqlite",
  "registries": {
    "kinds": ["rule", "recipe", "tool"],
    "signalSpecs": [...],
    "anchorKinds": ["git", "week"]
  }
}
\`\`\`

### Namespace Isolation
Isolate multiple projects/agents sharing a store via \`namespaceScope: ["tenant-a"]\`.`,
  },
  {
    name: 'sync',
    title: 'Distributed Consensus & Synchronization',
    description: 'Git-ref and file adapters, CRDT mathematical convergence, and CAS.',
    template: `# Distributed Consensus & Sync

Medha synchronizes evidence between machines without centralized servers.

### Adapters
1. **Git Ref Sync (\`refs/medha/memory\`)**:
   - Zero-checkout plumbing: uses git objects directly, leaves working tree untouched.
   - Atomic CAS (Compare-And-Swap) commits ensure push divergence is detected safely.
   \`\`\`sh
   medha sync status
   medha sync pull
   medha sync push
   \`\`\`
2. **File Sync**:
   - Shared JSON snapshot file with CAS checksum protection for air-gapped systems.

### Merge Properties
Episode logs merge deterministically:
- **Commutative**: A ∪ B = B ∪ A (merge order does not matter).
- **Associative**: (A ∪ B) ∪ C = A ∪ (B ∪ C) (network partitions heal safely).
- **Idempotent**: A ∪ A = A (redundant pulls cause zero side effects).
- **Retraction Resolution**: Masked episodes are tracked canonically across differing local sequence numbers.`,
  },
];
