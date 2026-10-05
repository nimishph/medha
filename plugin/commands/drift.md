---
description: List entities whose recent behavior diverges from their baseline, most-drifted first.
---

Show what is drifting in this project.

1. Prefer the `drift` MCP tool when the medha MCP server is connected; otherwise run
   `medha drift --json`.
2. Lead with the worst offenders — entity, direction, and how far off the baseline it is — then
   summarize the rest in one line.
3. When nothing is drifting, say that plainly and stop.
