---
description: Engine health: preflight integrity, status distribution, drift count.
---

Report the health of this project's medha engine.

1. Prefer the `status` MCP tool when the medha MCP server is connected; otherwise run
   `medha status --json`.
2. Summarize what matters: store path, entity counts by status, how many entities are drifting, and
   any preflight problem, in that order.
3. If the command fails because the home is not initialized, say so and stop: the fix is
   `medha init` in the project root. Do not initialize on the user's behalf without being asked.
4. If nothing is wrong, one short sentence is enough — do not pad the report.
