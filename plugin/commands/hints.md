---
description: Trust hints for the entity keys given as arguments, unknowns treated as probation.
---

Fetch trust hints for these keys: $ARGUMENTS

1. Prefer the `hints` MCP tool with `compact: true` — one call covers every key. Without MCP, run
   `medha show --id <key>` per key.
2. Report each returned hint as it stands: trust score, status, and the entity text if useful.
3. List `unknown` keys separately and treat them exactly like probation: worth mentioning if they
   look reasonable, not established guidance. Never report an unknown key as an error.
4. If no keys were given, ask which keys to check (or suggest `medha list` to browse).
