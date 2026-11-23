/**
 * `.medha/README.md`: a static explainer written by `medha init` and `MedhaClient.init()`, so
 * whoever finds the directory knows what it is.
 */
export const medhaHomeReadme = (backend: 'sqlite' | 'file' | 'memory'): string => `# .medha/

This directory is a [Medha](https://github.com/nimishph/medha) evidential-memory store, created
by \`medha init\`. It records what happened to your rules, recipes, and tools, and returns trust
hints — it never decides anything for you.

## What's here

- **\`config.json\`** — the single source of truth: backend, store path, and the registries
  (kinds, signals, thresholds). Meant to be committed; it's small and human-reviewable.
- **the store itself** (\`${backend === 'sqlite' ? 'store.sqlite' : 'state.jsonl'}\`) — the
  append-only episode log Medha folds into trust. Gitignored by default: share it with a team via
  \`medha sync\` (a dedicated git ref or a snapshot file), not by committing it directly. If you'd
  rather commit it as a simple, manual sync, delete or edit \`.gitignore\`.

## Useful commands

\`\`\`sh
medha list                                # what Medha knows, ranked by trust
medha maintain preflight                  # verify store integrity and registry match
medha maintain backup snapshot.json       # atomic, portable snapshot
medha sync status                         # compare against the shared ref/file
\`\`\`

Run \`medha --help\` for the full command surface.
`;
