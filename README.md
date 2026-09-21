# sage

The evidential-memory engine behind Sutra's guiding policy, as a library. Sage weighs what the
host has actually observed (episodes, signals, guard reports) and produces trust-shaped hints for
rules, recipes and tools — it never decides an action itself.

Extracted from the Sutra repository (see `SAGE-PORT-HANDOFF.md` and the `Loom-ujs3` epic there).
Loom consumes this checkout via a sibling path (`SAGE_SRC` or `../sutras/sage`) until the packages
are published.

## Packages

| Package | Contains | Depends on |
|---|---|---|
| `@sutras/sage-core` | Types, the math (Wilson, EMA, guards, decay, durability, thresholds), signal and kind registries, the ports, typed errors | nothing |
| `@sutras/sage-store` | Memory, file and SQLite backends, the shared contract suite | `sage-core` |
| `@sutras/sage-sync` | Optional sync-port adapters | `sage-core` |
| `@sutras/sage` | Engine facade (planes, sweep, exploration helper), CLI, MCP | `sage-core`, `sage-store`, `sage-sync` |

Boundaries are enforced from the first commit by dependency-cruiser (inward only, through each
package's `index`).

## Engineering standards

The same standards as `@sutras/code-lens`:

- no static caps or blind truncation — limits derive from real constraints, are caller-supplied,
  and are always reported (`LimitReport`); overflow chunks or paginates instead of cutting
- no empty `catch` — every catch handles, wraps with a typed `SageError` carrying context, or rethrows
- no bare `Error` — throw typed `SageError` subclasses with a stable `code`, `subsystem`, `context` and cause chain

These are enforced by Biome, four Grit plugin rules in `tooling/plugins/`, and the fixture suite in
`tooling/standards.test.ts` (the same fixtures as `code-lens`, proving the rules do what they claim).

## Development

```sh
bun install
bun run check     # lint + typecheck + boundaries + test
```

Requires Bun >= 1.3.