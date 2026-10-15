# ADR-0001: Rust becomes the engine; TypeScript becomes a thin wrapper

**Status:** Accepted (direction); the release switch is gated (see Action Items)
**Date:** 2026-10-15
**Deciders:** Nimish Phalnikar

## Context

medha has two full stacks over one on-disk store (`.medha/config.json` + `store.sqlite`):

- **TypeScript**: the reference engine, the CLI shipped on npm (Bun-compiled), the MCP server, the
  dashboard, sync, signing.
- **Rust** (`crates/`): engine, store, sync, CLI, MCP and a NAPI bridge. It is thinner. It has no kind
  specs in the store fold, a simpler maintenance plane, about half the CLI commands, a different
  `--json` shape and no signing. Nothing in the TypeScript engine calls the NAPI bridge.

Measured on Windows, 2026-10-15:

| | TypeScript binary | Rust binary |
|---|---|---|
| Size | 60–83 MB per platform | 6.8 MB |
| Startup (`--version`) | 212 ms | 27 ms |
| `mcp serve` working set | 45 MB | 7 MB |

The original goals (medha-wlu) still hold: fast cold starts for hook-driven use, a small binary for
`npx` installs, and Python/WASM embedding.

History to learn from: 0.7.0 made the Rust CLI the shipped binary before it matched the TypeScript
one, and regressed (issue #11: sync was a no-op, commands were missing, the CLI and MCP surfaces
diverged). 0.7.1 reverted the same day. Until medha-50q.6, the two engines could also damage each
other's stores (different JSON field names).

## Decision

Long term, the Rust engine is the one implementation of the trust model, store, sync and CLI/MCP
surface. TypeScript keeps a thin layer: the npm launcher, and a library binding to the Rust engine for
Node/Bun hosts.

Until the switch, the TypeScript engine stays the reference and the shipped binary. Every behavior
change lands in both engines, the parity test (`medha/src/__tests__/rust-parity.test.ts`) guards it,
and the spec plus conformance vectors stay the language-neutral contract.

## Options considered

- **A. TypeScript only.** One engine, the least maintenance. Gives up size, startup and embedding.
- **B. TypeScript engine + Rust kernel over NAPI.** Keeps a second kernel nobody calls.
- **C. Rust engine, thin TypeScript wrapper (chosen).** Footprint and embedding wins. Costs a full
  port, plus a long dual-maintenance period until the switch.
- **D. Keep both indefinitely.** Every feature twice, forever.

## Consequences

- **Easier later:** small, fast binaries; hooks can spawn `medha` per call; Python and WASM
  embedding; one implementation to reason about after the switch.
- **Harder now:** every change lands twice until the switch. The parity test is the safety net and
  must grow to cover the whole surface.
- **To decide during the port:** how custom weight updaters (`<home>/updaters/*.ts`) work without a
  JS runtime; how the dashboard (`medha ui`) is served; whether `@cntxt-labs/medha` (the library)
  binds to Rust over NAPI or stays a TypeScript engine for hosts that embed it.

## Action items

Tracked as the epic filed with this ADR. The release switch is the last item and is gated: the
shipped binary does not change until the Rust CLI passes the TypeScript CLI's own test suite and the
parity test covers kind specs, maintenance, decision trees and CLI output.
