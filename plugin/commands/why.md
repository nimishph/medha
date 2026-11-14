---
description: Explain why an entity has its current trust score and lifecycle status.
---

Explain the evidential trust and threshold standing for entity: $ARGUMENTS

1. If no entity ID was specified in $ARGUMENTS, ask the user which entity key or ID they want explained.
2. Run `medha show --id $ARGUMENTS` (or use `show_entity` MCP tool) to inspect the entity's trust score, components (Wilson lower bound L, Guard factor G, Recency R, Durability D), and recent episodes.
3. Run `medha explain-threshold --id $ARGUMENTS` to evaluate each lifecycle gate (active, trusted, quarantined, retired) and see which thresholds are satisfied or failing.
4. Summarize clearly:
   - Current trust score and status (probation, active, trusted, quarantined, or retired).
   - Guard status (whether a passing guard is recorded or if trust is capped at unguarded ceiling).
   - Recent signals and trials (successes vs failures, recent drift).
   - What specific evidence or guard is required to change status.
