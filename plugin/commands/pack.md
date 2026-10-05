---
description: Pack the most-trusted active and probation guidance into a context window.
---

Pack guidance into a token budget: $ARGUMENTS

1. Treat a bare number in the arguments as the token budget; if there is none, use 2000.
2. Prefer the `pack_context` MCP tool with that budget; otherwise run
   `medha pack --budget <n> --json`.
3. Present the packed entities as guidance the reader can act on, keeping medha's own ordering —
   better-evidenced entities come first because the budget bought them.
4. This is a read: record nothing, and do not restate entities that were filtered out.
