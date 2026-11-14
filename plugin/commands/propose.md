---
description: Propose a new rule or recipe from the conversation with its provenance source.
---

Propose a new rule or recipe for medha evidential memory: $ARGUMENTS

1. Identify the rule, recipe, or guideline discussed in the conversation, along with its id, text, and source (e.g. human observation, incident, PR review, or agent experience).
2. Prefer the `propose` MCP tool when connected (`{ id, text, source, kind: "rule" }`). Without MCP, run `medha propose --id <id> --text "<text>" --source "<source>"`.
3. If arguments were provided in $ARGUMENTS, parse the id and options from them; otherwise extract the candidate entity from recent discussion and confirm with the user before recording.
4. Explain that newly proposed entities start on probation with initial neutral trust until evidence or guard results accumulate.
