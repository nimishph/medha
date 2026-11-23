# ADR-0002: The SDK binds to the Rust engine over NAPI

**Status:** Proposed
**Date:** 2026-11-23
**Deciders:** Nimish Phalnikar
**Supersedes:** ADR-0001, resolved decision 2 (`@cntxt-labs/medha` stays pure TypeScript)
**Plan:** `plans/sdk-on-rust-engine.md`

## Context

ADR-0001 made Rust the engine and the CLI now ships as the Rust binary. Its resolved decision 2
kept the library, `@cntxt-labs/medha`, a pure TypeScript engine, with native bindings offered on the
side as `@cntxt-labs/medha-napi`.

0.8.0-alpha.2 shows what that leaves:

- **Two engines, side by side.** The CLI package is a Node launcher that runs `medha` (Rust). The SDK
  bundles the TypeScript engine (`medha-core`, `medha-store`, `medha-sync`, about 13,000 lines) into
  `dist/index.js`. A runtime trace of the SDK loads no native code and starts no process.
- **They drift.** The alpha.1 field test found the CLI and the SDK disagreeing on four behaviours
  (record without `--ensure`, guard without a kind, `pack --budget`, the home README). Each was a
  fix in one engine that never reached the other.
- **The parity net is large.** The engine parity driver, the CLI parity gate and a black-box
  comparison exist only to hold the two engines together.
- **The NAPI crate is unused.** `crates/medha-napi` exports the trust maths (Wilson, recency, EMA,
  trust and status), and `medha-core/src/rust-bridge.ts` can load it, but nothing calls it.
  `@cntxt-labs/medha-napi` was never published.

The reason given for decision 2, compatibility across Node, Bun and browsers, holds only in part.
The SDK already needs `node:fs` and `node:sqlite` or `bun:sqlite`, so it does not run in a browser
today.

## Decision

`@cntxt-labs/medha` runs on the Rust engine (`crates/medha`) through a NAPI addon, so the CLI and the
SDK share one implementation of the trust model, the store, sync and signing. The SDK's public API
and types do not change.

- The addon exposes an engine handle with every operation the SDK uses, taking and returning JSON
  in the shapes of the existing TypeScript types. Store I/O runs off the JS thread. Errors keep the
  TypeScript `code`, `context` and `hint`.
- The addon ships inside the existing platform packages (`@cntxt-labs/medha-<os>-<cpu>`) next to
  the CLI binary. The SDK lists them as optional dependencies.
- While the TypeScript engine exists, it stays inside the SDK as the fallback. The client picks
  Rust when the addon loads and every option it was given can run there. `client.engineKind` says
  which engine runs, and `MEDHA_ENGINE=typescript|rust` forces one.
- The CLI keeps running the Rust binary directly. It does not go through the SDK, because a JS
  runtime in front of every call brings back the startup cost ADR-0001 removed.
- The default flips to Rust in its own release, only when the SDK's own test suite passes against
  the Rust engine (`test:sdk-parity`), the engine parity test passes, and a black-box run of the
  packed release matches.

Deleting the TypeScript engine is a separate, later decision.

## Options considered

- **A. Keep the SDK pure TypeScript (ADR-0001 decision 2).** Nothing to build or ship natively, and
  it runs wherever `node:sqlite` or `bun:sqlite` does. But the two engines stay and keep drifting,
  every change lands twice, and the parity net stays.
- **B. NAPI addon in process (chosen).** Calls stay in process, with no per-call startup. Native
  SQLite shares WAL and file locking with the CLI on the same store. Node and Bun both load NAPI
  addons. Costs: a native build per platform, install failures a pure-JS package never has, and
  JavaScript callbacks that are awkward to call from Rust.
- **C. WebAssembly.** One artefact for every platform. But SQLite in WASM cannot share native file
  locks with the CLI on the same `store.sqlite`. File access needs WASI or JS shims, and WASM runs
  slower than native. Worth revisiting for browser or edge embedding, which is not a goal today.
- **D. Spawn the CLI per call.** Reuses the binary already shipped, with no new artefact. But every
  call pays process startup (about 27 ms), and long-lived state such as an open store and caches is
  lost between calls.
- **E. A long-lived engine subprocess speaking JSON-RPC over stdio** (as `medha mcp serve` does).
  No native addon, and startup is paid once. But the host has to manage a child process, every call
  crosses a pipe, and the SDK becomes a protocol client that must track the CLI's version. It is a
  sound fallback if NAPI distribution proves too costly.

## Extension points

Five SDK options run user JavaScript inside the engine today. Each needs a defined answer:

| Option | First release | Later |
|---|---|---|
| custom `store` (`StorePort`) | TypeScript engine | NAPI callbacks, only if users ask |
| custom weight `updaters` | TypeScript engine (built-ins already run in Rust) | NAPI callbacks, only if users ask |
| `sync` port | TypeScript engine | Rust sync covers git and file targets |
| `promotionPolicy` | TypeScript engine | declarative policy in `config.json`, run in Rust |
| write `permissions` | TypeScript engine | declarative policy in `config.json`, run in Rust |

When any of these is passed, the client picks the TypeScript engine and reports it in `engineKind`.
It does not fail, and it does not silently drop the option.

## Consequences

- **Easier:** one behaviour behind both surfaces, and a fix lands once. Hosts that embed the SDK
  (MCP servers, agent hooks) get native performance. Signing and sync are one implementation, so a
  store written through either surface verifies in the other. The engine parity driver and most of
  the black-box comparison can go once the TypeScript engine is retired.
- **Harder:** the release workflow builds the addon on five platforms, and a smoke test must
  confirm `engineKind === 'rust'` on each. Until the TypeScript engine is removed, the SDK carries
  both engines, so its package grows by the addon's size. Stack traces stop at the binding.
- **To decide later:** whether to remove the TypeScript engine (its own ADR, after one release on
  the Rust default), and whether custom stores and updaters get NAPI callbacks.

## Action items

Tracked in `plans/sdk-on-rust-engine.md`:

1. Grow `crates/medha-napi` into an engine binding (`req-napi-engine`).
2. Put an engine port in the SDK, with `RustEngine` and `engineKind` (`req-seam`).
3. Run the SDK suite against both engines with `test:sdk-parity` (`req-sdk-parity`).
4. Ship the addon in the platform packages and build it in the release workflow (`req-packaging`).
5. Remove the unused kernel bridge (`req-no-dead-bridge`).
6. Flip the default behind the gate (`req-gate`).
