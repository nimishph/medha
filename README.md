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
| `@cntxt-labs/medha-core` | Types, the math (Wilson, EMA, guards, decay, durability, thresholds), signal and kind registries, the ports, typed errors | nothing |
| `@cntxt-labs/medha-store` | Memory, file and SQLite backends, the shared contract suite | `sage-core` |
| `@cntxt-labs/medha-sync` | Optional sync-port adapters | `sage-core` |
| `@cntxt-labs/medha` | Engine facade (planes, sweep, exploration helper), CLI, MCP | `sage-core`, `sage-store`, `sage-sync` |

Boundaries are enforced from the first commit by dependency-cruiser (inward only, through each
package's `index`).

## Engineering standards

The same standards as `@sutras/code-lens`:

- no static caps or blind truncation — limits derive from real constraints, are caller-supplied,
  and are always reported (`LimitReport`); overflow chunks or paginates instead of cutting
- no empty `catch` — every catch handles, wraps with a typed `MedhaError` carrying context, or rethrows
- no bare `Error` — throw typed `MedhaError` subclasses with a stable `code`, `subsystem`, `context` and cause chain

These are enforced by Biome, four Grit plugin rules in `tooling/plugins/`, and the fixture suite in
`tooling/standards.test.ts` (the same fixtures as `code-lens`, proving the rules do what they claim).

## Development

```sh
bun install
bun run check     # lint + typecheck + boundaries + test
```

Requires Bun >= 1.3.
## CLI & MCP Server

Sage ships with both a unified command line interface and an MCP (Model Context Protocol) server over stdio.

### CLI Subcommands

- **`medha init`**: Initialize engine home (`.medha/config.json` + store). Use `--home <path>` to place the home elsewhere; standalone sage never touches `.sutra/` unless told to.
- **`sage list`**: List evidential entities filtered by kind, status, namespace, or drift.
- **`sage show`**: Inspect an entity with its trust breakdown, temporal state, and recent episodes.
- **`sage status`**: Check overall store health, preflight status, and entity lifecycle distribution.
- **`sage drift`**: Identify entities whose weights have drifted from their priors.
- **`sage params`**: Print the canonical mathematical constants and thresholds used by the kernel.
- **`sage simulate`**: Compute the hypothetical trust delta of a signal without persisting changes.
- **`sage explain-threshold`**: Show which thresholds an entity clears (trusted, active) and why.
- **`medha maintain`**: Maintenance commands:
  - `medha maintain preflight`: Check store integrity and verify registry match.
  - `medha maintain compact [--older-than <days>]`: Fold historical episodes into baselines and name the folded range.
  - `medha maintain backup <path>`: Export an atomic, portable `MedhaSnapshot` JSON file.
  - `medha maintain restore <path>`: Headlessly restore store state from a snapshot.
- **`medha updater`**: Weight-updater commands:
  - `medha updater list`: List all registered updaters (project -> user -> built-in).
  - `medha updater show <name>`: Inspect an updater's strategy and details.
  - `medha updater fork <name> [--out <path>]`: Scaffold a custom TypeScript updater template.
- **`medha mcp [serve]`**: Run the stdio Model Context Protocol (MCP) server.

### MCP Tools

The MCP server exposes 9 tools over JSON-RPC stdio:
1. `hints`: Batch fetch hints for entity keys.
2. `list_entities`: Paginated search with filtering.
3. `show_entity`: Detailed entity inspection.
4. `record_signal`: Record evidential signals (`APPLY`, `REJECT_RULE`, `SKIP`, etc.).
5. `report_guard`: Record verification/guard results.
6. `propose`: Submit candidate entity proposals for promotion.
7. `drift`: List drifting entities.
8. `simulate`: Preview the trust delta of a signal.
9. `status`: Engine health and preflight report.

### Packaging & Smoke Testing

To package the standalone native binary for your platform:

```sh
bun run build     # compiles cli/src/bin.ts to dist/sage/sage[.exe]
bun run smoke     # runs init, list, status, drift, and MCP handshake on todo-list
```
