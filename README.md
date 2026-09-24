# medha

The evidential-memory engine behind Sutra's guiding policy, as a library. Medha weighs what the
host has actually observed (episodes, signals, guard reports) and produces trust-shaped hints for
rules, recipes and tools — it never decides an action itself.

Extracted from the Sutra repository. Loom consumes this checkout via a sibling path
(`MEDHA_SRC` or `../sutras/medha`) until the packages are published.

## Packages

| Package | Contains | Depends on |
|---|---|---|
| `@cntxt-labs/medha-core` | Types, the math (Wilson, EMA, guards, decay, durability, thresholds), signal and kind registries, the ports, typed errors | nothing |
| `@cntxt-labs/medha-store` | Memory, file and SQLite backends, the shared contract suite | `medha-core` |
| `@cntxt-labs/medha-sync` | Optional sync-port adapters | `medha-core` |
| `@cntxt-labs/medha` | Engine facade (planes, sweep, exploration helper), CLI, MCP | `medha-core`, `medha-store`, `medha-sync` |

Boundaries are enforced from the first commit by dependency-cruiser (inward only, through each
package's `index`).

## Engineering standards

The same standards as `@cntxt-labs/anvesa`:

- no static caps or blind truncation — limits derive from real constraints, are caller-supplied,
  and are always reported (`LimitReport`); overflow chunks or paginates instead of cutting
- no empty `catch` — every catch handles, wraps with a typed `MedhaError` carrying context, or rethrows
- no bare `Error` — throw typed `MedhaError` subclasses with a stable `code`, `subsystem`, `context` and cause chain

These are enforced by Biome, four Grit plugin rules in `tooling/plugins/`, and the fixture suite in
`tooling/standards.test.ts` (the same fixtures as `anvesa`, proving the rules do what they claim).

## Development

```sh
bun install
bun run check     # lint + typecheck + boundaries + test
```

Requires Bun >= 1.3.

## CLI & MCP Server

Medha ships with both a unified command line interface and an MCP (Model Context Protocol) server over stdio.

### CLI Subcommands

- **`medha init`**: Initialize engine home (`.medha/config.json` + store). Use `--home <path>` to place the home elsewhere; standalone medha never touches `.sutra/` unless told to.
- **`medha list`**: List evidential entities filtered by kind, status, namespace, or drift.
- **`medha show`**: Inspect an entity with its trust breakdown, temporal state, and recent episodes.
- **`medha status`**: Check overall store health, preflight status, and entity lifecycle distribution.
- **`medha drift`**: Identify entities whose weights have drifted from their priors.
- **`medha params`**: Print the canonical mathematical constants and thresholds used by the kernel.
- **`medha simulate`**: Compute the hypothetical trust delta of a signal without persisting changes.
- **`medha explain-threshold`**: Show which thresholds an entity clears (trusted, active) and why.
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
bun run build     # compiles cli/src/bin.ts to dist/medha/medha[.exe]
bun run smoke     # runs init, list, status, drift, and MCP handshake on todo-list
```

## Author & Attribution

Authored by **[@nimishph](https://github.com/nimishph)**.

## License

MIT © [Nimish Phalnikar](https://github.com/nimishph)
