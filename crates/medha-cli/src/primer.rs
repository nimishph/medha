use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrimerTopicItem {
    pub name: String,
    pub title: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrimerResult {
    pub topic: String,
    pub title: String,
    pub description: String,
    pub content: String,
    #[serde(rename = "lineCount")]
    pub line_count: usize,
    #[serde(rename = "availableTopics")]
    pub available_topics: Vec<PrimerTopicItem>,
}

struct TopicDef {
    name: &'static str,
    title: &'static str,
    description: &'static str,
    content: &'static str,
}

const TOPICS: &[TopicDef] = &[
    TopicDef {
        name: "overview",
        title: "Medha: Evidential Memory Overview",
        description: "What Medha is, core philosophy, and essential command cheatsheet.",
        content: r#"# Medha: Evidential Memory Engine

Medha tracks real-world outcomes for rules, recipes, and tools, returning calibrated **trust hints**.
Core philosophy: **Medha records evidence; you decide what to do with it.**

### Essential Commands
- `medha init` — Initialize `.medha/` home directory with configuration and store.
- `medha show <kind> <id>` — Inspect trust breakdown (Wilson, guard, recency, durability).
- `medha record <kind> <id> <signal>` — Record an observed signal (e.g. APPLY, REJECT_RULE).
- `medha guard <kind> <id> --ok / --fail` — Record automated verification outcome.
- `medha propose <kind> <id> <signal>` — Stage a signal without immediately appending.
- `medha define <kind> <id>` — Define an entity and optional decision tree.
- `medha drift` — Detect upward or downward divergence in entity reliability.
- `medha pack --budget <tokens>` — Compress top trusted guidance into active context budget.
- `medha sync status|pull|push` — Synchronize memory across git refs or shared files.
- `medha ui` — Launch local real-time web dashboard.
- `medha primer [topic]` — Read token-frugal agent guidance on a specific topic.
- `medha issue [title]` — Prepare prefilled GitHub issue with sanitized diagnostics.
- `medha mcp config <client> --write` — Register the MCP server with a client (`--list` for ids).
- Documentation: [nimishph.github.io/medha](https://nimishph.github.io/medha/) (or `bun run docs:dev` locally)."#,
    },
    TopicDef {
        name: "mental-model",
        title: "The Dual-Loop Architecture & Lifecycle",
        description: "Fast inner loop vs slow outer loop, and lifecycle status progression.",
        content: r#"# The Dual-Loop Architecture

Medha decouples real-time reasoning from background evidence calibration:

```text
  FAST INNER LOOP: Agent Task -> Query Hints -> Decision -> Apply Rule
                                                               |
  SLOW OUTER LOOP: Calibrated Status <- Trust Engine <- Record Evidence
```

1. **Fast Inner Loop (Execution)**:
   - Query `hints` or `medha show` before applying rules or tools.
   - Inject `trusted` items into system prompts; treat `probation` with skepticism.
2. **Slow Outer Loop (Evidence)**:
   - When actions succeed or fail, report ground truth (`APPLY`, `REJECT_RULE`, `guard`).
   - Evidential engine continuously refolds the append-only log into entity states.

### Entity Lifecycle Statuses
- **Probation**: New entity with few trials. Wilson lower bound discounts score ($L < 0.50$).
- **Active**: Established positive track record ($L \ge 0.50$). Capped at 0.85 until guarded.
- **Trusted**: Highly reliable ($L \ge 0.85$) with at least one verified passing guard check.
- **Quarantined**: Severe negative drift or failure spike. Discounted from active suggestions.
- **Retired**: Dropped below retirement threshold ($T < 0.20$) or superseded by retractions."#,
    },
    TopicDef {
        name: "signals",
        title: "Signals & Evidence Accrual",
        description: "Built-in signals, trial vs success counts, weights, and author caps.",
        content: r#"# Signals & Evidence

Evidence is recorded as immutable episodes in an append-only log.

### Built-in Canonical Signals
- **`APPLY`** (value: `+1.0`, trial: `true`, success: `true`):
  The rule, recipe, or tool was applied and achieved the desired outcome.
- **`REJECT_RULE`** (value: `-1.0`, trial: `true`, success: `false`):
  A human or test rejected the rule as incorrect, counterproductive, or harmful.
- **`SKIP`** (value: `0.0`, trial: `false`, success: `false`):
  Not applicable to the current context. Neutral observation; does NOT penalize trust.
- **`REJECT_CONTEXT`** (value: `0.0`, trial: `false`, success: `false`):
  Rule was rejected due to an environmental mismatch, not a defect in the rule itself.

### Usage
```sh
medha record rule no-any-type APPLY --author "agent-claude" --note "Clean build"
medha record rule old-polyfill REJECT_RULE --author "nimish" --note "Deprecated in Node 20"
```

### Author Diversity & Rate Limits
- Spec limits single-author dominance: `maxSuccessesPerAuthor` caps individual influence.
- `minIntervalMs` rejects rapid-fire duplicate signals from identical actors."#,
    },
    TopicDef {
        name: "guards",
        title: "Automated Guards & The Unguarded Ceiling",
        description: "Independent verification, guard factors, and elevating past probation.",
        content: r#"# Automated Guards & The Unguarded Ceiling

Usage frequency alone cannot prove correctness: a bad rule used 100 times is still bad.
Guards provide external, objective validation (e.g. test suites, linters, AST checks).

### The Unguarded Ceiling Invariant
- **Ceiling**: An entity without a passing guard is strictly capped at **0.85** trust (`Active`).
- No amount of positive `APPLY` signals can make an entity `Trusted` without a guard.
- A passing guard (`--ok`) unlocks the ceiling, allowing elevation to `Trusted`.

### Recording Guards
```sh
# Automated test suite passed
medha guard rule strict-typing --ok --note "tsc --noEmit exit 0"

# Automated test suite failed
medha guard rule strict-typing --fail --note "tsc reported 3 type errors"
```

### Guard Factor ($G$)
- Passing Guard: $G = 1.0$ (clean validation).
- Failing Guard: $G = 0.5$ or lower (heavy penalty).
- No Guard: $G = 1.0$, but score is subject to the 0.85 ceiling cap."#,
    },
    TopicDef {
        name: "decisions",
        title: "Entity Definitions & Decision Trees",
        description: "Per-branch evidence, conditions, and human approval gating.",
        content: r#"# Entity Definitions & Decision Trees

Medha supports contextual decision trees so rules can have branch-specific trust.

### Defining an Entity
```sh
medha define rule db-pool-size --description "Postgres pool sizing"
```

### Adding Decision Branches
```sh
# Branch 1: High concurrency serverless
medha rule db-pool-size decision "environment == 'lambda'" "max_connections = 5"

# Branch 2: Long-running container
medha rule db-pool-size decision "environment == 'container'" "max_connections = 50"
```

### Per-Branch Evidence
Signal episodes can target specific branch cases via `--case-id <id>`:
```sh
medha record rule db-pool-size APPLY --case-id case-8f2a1 --note "Lambda stable"
```
Evidence on one branch does not contaminate another branch.

### Human Approval Gating (`requireHumanFor`)
High-stakes decision branches can require explicit human confirmation:
```json
"decisionPolicy": {
  "requireHumanFor": ["production-drop-table", "release-deploy"]
}
```"#,
    },
    TopicDef {
        name: "drift",
        title: "Drift Detection & The Wilson Lower Bound",
        description: "Statistical drift, EMA tracking, and small-sample confidence.",
        content: r#"# Drift Detection & Wilson Confidence

### Wilson Score 95% Lower Bound ($L$)
Medha uses the Wilson score interval with continuity correction ($Z = 1.959964$):
- $2/2$ successes yields $L \approx 0.34$ (`Probation`).
- $200/200$ successes yields $L \approx 0.98$ (`Trusted`).
This mathematically eliminates small-sample overconfidence.

### Directional Drift
Run `medha drift` to inspect divergence between short-term EMA and long-term baseline:
```sh
medha drift
medha drift --kind rule --threshold 0.15
```

- **Downward Drift**: Entity is failing significantly more often recently than historically.
  *Action*: Flag for review or quarantine.
- **Upward Drift**: Entity has recovered or improved after recent fixes.
  *Action*: Review for promotion out of probation or quarantine."#,
    },
    TopicDef {
        name: "config",
        title: "Configuration, Schemas & Backends",
        description: ".medha/config.json structure, storage options, and namespace scoping.",
        content: r#"# Configuration & Storage

Stored in `.medha/config.json`, validated against JSON Schema Draft 2020-12.

### Storage Backends
1. **`sqlite` (Default & Recommended)**:
   - High-performance WAL mode store at `.medha/store.sqlite`.
   - Sub-millisecond queries, atomic transactions, supports 100k+ entities.
2. **`file`**:
   - Human-readable append-only JSONL document at `.medha/state.jsonl`.
   - Git-friendly and easily audited in diffs.
3. **`memory`**:
   - Ephemeral in-process store for unit tests and sandboxes.

### IDE Schema Integration
Include `$schema` in `.medha/config.json` for autocomplete and hover tooltips:
```json
{
  "$schema": "https://raw.githubusercontent.com/nimishph/medha/main/schemas/config.v1.json",
  "layoutVersion": 1,
  "backend": "sqlite",
  "registries": {
    "kinds": ["rule", "recipe", "tool"],
    "signalSpecs": [...],
    "anchorKinds": ["git-head"]
  }
}
```

### Namespace Isolation
Isolate multiple projects/agents sharing a store via `namespaceScope: ["tenant-a"]`."#,
    },
    TopicDef {
        name: "sync",
        title: "Distributed Consensus & Synchronization",
        description: "Git-ref and file adapters, CRDT mathematical convergence, and CAS.",
        content: r#"# Distributed Consensus & Sync

Medha synchronizes evidence between machines without centralized servers.

### Adapters
1. **Git Ref Sync (`refs/medha/memory`)**:
   - Zero-checkout plumbing: uses git objects directly, leaves working tree untouched.
   - Atomic CAS (Compare-And-Swap) commits ensure push divergence is detected safely.
   ```sh
   medha sync status
   medha sync pull
   medha sync push
   ```
2. **File Sync**:
   - Shared JSON snapshot file with CAS checksum protection for air-gapped systems.

### CRDT Mathematical Properties
Episode logs merge deterministically:
- **Commutative**: $A \cup B = B \cup A$ (merge order does not matter).
- **Associative**: $(A \cup B) \cup C = A \cup (B \cup C)$ (network partitions heal safely).
- **Idempotent**: $A \cup A = A$ (redundant pulls cause zero side effects).
- **Retraction Resolution**: Masked episodes are tracked canonically across differing local sequence numbers."#,
    },
];

pub fn available_topic_items() -> Vec<PrimerTopicItem> {
    TOPICS
        .iter()
        .map(|t| PrimerTopicItem {
            name: t.name.to_string(),
            title: t.title.to_string(),
            description: t.description.to_string(),
        })
        .collect()
}

pub fn get_primer(raw_topic: Option<&str>) -> Result<PrimerResult, String> {
    let normalized = raw_topic.unwrap_or("").trim().to_lowercase();
    let available = available_topic_items();

    if normalized.is_empty() || normalized == "index" || normalized == "help" {
        let mut lines = vec![
            "# Medha Primer Index".to_string(),
            "".to_string(),
            "Medha is an evidential memory engine. Use this primer for token-frugal agent guidance.".to_string(),
            "".to_string(),
            "### Available Topics".to_string(),
        ];
        for t in &available {
            lines.push(format!(
                "- **`{}`**: {} — *{}*",
                t.name, t.title, t.description
            ));
        }
        lines.push("".to_string());
        lines.push("### Usage".to_string());
        lines.push("- CLI: `medha primer <topic>` (e.g. `medha primer signals`)".to_string());
        lines.push("- CLI JSON: `medha primer <topic> --json`".to_string());
        lines.push("- MCP Tool: `primer(topic: \"guards\")`".to_string());

        let line_count = lines.len();
        let content = lines.join("\n");
        return Ok(PrimerResult {
            topic: "index".to_string(),
            title: "Medha Primer: Available Topics".to_string(),
            description: "Index of available agent primer topics.".to_string(),
            content,
            line_count,
            available_topics: available,
        });
    }

    if let Some(def) = TOPICS.iter().find(|t| t.name == normalized) {
        let line_count = def.content.lines().count();
        Ok(PrimerResult {
            topic: def.name.to_string(),
            title: def.title.to_string(),
            description: def.description.to_string(),
            content: def.content.to_string(),
            line_count,
            available_topics: available,
        })
    } else {
        let valid = TOPICS
            .iter()
            .map(|t| format!("'{}'", t.name))
            .collect::<Vec<_>>()
            .join(", ");
        Err(format!(
            "Unknown topic '{}'. Must be one of {}",
            normalized, valid
        ))
    }
}

pub fn render_primer(result: &PrimerResult, compact: bool) -> String {
    if compact {
        format!("{}\n", result.content)
    } else {
        format!(
            "{}\n\n---\n*Medha Primer ({}) | Run 'medha primer' to view all topics.*\n",
            result.content, result.topic
        )
    }
}
