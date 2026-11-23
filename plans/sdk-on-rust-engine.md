---
id: plan/sdk-on-rust-engine
title: The SDK runs on the Rust engine
status: in-progress
beads: []
---

# The SDK runs on the Rust engine

Today medha ships two engines that never call each other. The CLI (`@cntxt-labs/medha-cli`) is a
Node launcher that runs the Rust binary. The SDK (`@cntxt-labs/medha`) is a self-contained
TypeScript engine (`medha-core`, `medha-store`, `medha-sync` bundled into `dist/index.js`, about
13,000 lines). They agree only because parity tests hold them together, and the 0.8.0-alpha.1 field
test showed how far they can drift between runs of those tests.

This plan funnels both surfaces into one implementation of the trust model, the store and sync:

```
medha (CLI)  ──► medha.exe (Rust) ─────────────┐
                                               ├──► crates/medha (engine, store, sync)
@cntxt-labs/medha (SDK) ──► medha.node (NAPI) ─┘
```

Out of scope here: deleting the TypeScript engine. That is a later plan, after the default has
flipped and one release has gone out on it.

## Why

- **One behaviour.** The CLI and the SDK cannot disagree, because there is one engine behind them:
  every difference found in the alpha.1 test (record without `--ensure`, guard without a kind,
  `pack --budget`, README) would have been impossible or fixed once.
- **Changes land once.** ADR-0001 says every change lands in both engines until the switch. The SDK
  is the last thing keeping that rule alive for the engine.
- **Smaller tests.** The parity driver, the engine parity test and most of the black-box comparison
  become unnecessary. They guard against a gap this plan closes.
- **Speed and footprint.** Folding, packing and SQLite access run natively. Hosts that embed the
  SDK (MCP servers, agent hooks) get the same numbers as the CLI.
- **Same signing and sync.** Signature checks and the sync protocol are one implementation, so a
  store written by one surface always verifies in the other.

What it costs:

- **A native addon per platform** to build, publish and support (5 targets today), and install
  failures that a pure-JS package never has.
- **Runtimes without NAPI lose the SDK**: browsers, edge workers, Deno without its Node layer.
  The SDK already needs `node:fs` and `node:sqlite`/`bun:sqlite`, so in practice this is small.
- **JavaScript extension points get harder**: a custom `StorePort`, custom weight updaters, a
  `SyncPort`, promotion and permission callbacks all run in JS today. Calling them across the FFI
  boundary is possible but slow and complex (see the extension-points requirement).
- **Debugging spans two languages.** Stack traces stop at the binding.

## Requirement: an ADR records the change of direction {#req-adr}

ADR-0001's resolved decision 2 keeps `@cntxt-labs/medha` a pure TypeScript engine, with an optional
`@cntxt-labs/medha-napi` on the side. This plan reverses that. ADR-0002 records the new decision,
the options weighed (NAPI, WASM, spawning the CLI per call), and why NAPI wins: in-process calls,
real SQLite, Bun and Node both support it. ADR-0001 is marked superseded on that point.

```yojana:claim
kind: path
expression: docs/adr/0002-sdk-binds-rust-engine.md
```

```yojana:claim
kind: text
expression: /Superseded by ADR-0002/ in docs/adr/0001-rust-engine.md
```

## Requirement: the NAPI binding exposes the engine, not only the maths {#req-napi-engine}

`crates/medha-napi` exports math kernels today (Wilson, recency, EMA, trust), which nothing calls.
It gains an engine handle that opens a home (or a memory store) and exposes every public
`MedhaEngine` operation the SDK needs: record, guard, propose, define, decision, retract,
reinstate, remove-episode, hints, show, list, drift, simulate, pack, hints-for-context,
detect-pitfalls, distill, policy-latch, preflight, backup, restore, compact and adopt.

Calls take and return JSON values whose shapes match the TypeScript types (`EvidentialHint`,
`PackOutcome`, …), so the SDK's types stay as they are. Store I/O runs as async tasks off the JS
thread. Engine errors arrive as JS errors carrying the same `code`, `context` and `hint` as the
TypeScript `MedhaError`s.

```yojana:claim
kind: text
expression: /pub struct NapiEngine/ in crates/medha-napi/src/**/*.rs
```

```yojana:claim
kind: text
expression: /AsyncTask|async fn/ in crates/medha-napi/src/**/*.rs
```

## Requirement: the SDK reaches the engine through one seam {#req-seam}

`MedhaClient` and `AgentSession` keep their public API. Underneath, they talk to an engine port with
two implementations: the existing TypeScript `Medha`, and `RustEngine`
(`medha/src/rust-engine.ts`) over the addon. The client reports which one it runs on
(`client.engineKind`: `'rust'` or `'typescript'`), and `MEDHA_ENGINE=typescript|rust` forces one.

```yojana:claim
kind: path
expression: medha/src/rust-engine.ts
```

```yojana:claim
kind: text
expression: engineKind in medha/src/client.ts
```

## Requirement: the SDK's own tests pass on both engines {#req-sdk-parity}

As `test:cli-parity` does for the CLI: a script runs the SDK suite (`medha/src/**/*.test.ts`) with
`MEDHA_ENGINE=rust`, against a freshly built addon. Tests that exercise JS-only extension points
(below) are marked and expected to report the TypeScript engine instead. The default flips only
when this suite is green.

```yojana:claim
kind: text
expression: test:sdk-parity in package.json
```

## Requirement: JavaScript extension points have a defined answer {#req-extension-points}

Five SDK options run user JavaScript inside the engine: a custom `store` (`StorePort`), custom
weight `updaters`, a `sync` port, a `promotionPolicy`, and write `permissions`. For each, the plan
settles one of: (a) reimplemented in Rust from declarative config (built-in updaters already are),
(b) called back across NAPI with a thread-safe function, or (c) kept on the TypeScript engine,
which the client then picks automatically and reports in `engineKind`.

Proposed starting point, to confirm in ADR-0002: (c) for all five in the first release, then (a) for
promotion and permissions, which are small and declarative, and (b) only if users ask for custom
stores or updaters.

```yojana:claim
kind: text
expression: /extension points/i in docs/adr/0002-sdk-binds-rust-engine.md
```

## Requirement: the addon ships in the platform packages {#req-packaging}

The `.node` file goes into the existing `@cntxt-labs/medha-<os>-<cpu>` packages next to the CLI
binary, so one platform download serves both. `@cntxt-labs/medha` lists those packages as optional
dependencies, as the CLI launcher does. If the addon for the machine is missing, the SDK falls back
to the TypeScript engine and warns once. While the TypeScript engine exists, the SDK never fails to
load because of the addon.

The release workflow builds the addon for each platform in its matrix. A smoke test installs the
packed SDK and checks `engineKind === 'rust'` on every platform.

```yojana:claim
kind: text
expression: medha-napi in .github/workflows/release.yml
```

```yojana:claim
kind: text
expression: /medha-(linux|darwin|win32)-/ in medha/package.json
```

## Requirement: the unused kernel bridge is gone {#req-no-dead-bridge}

`medha-core/src/rust-bridge.ts` (`loadRustCore`) is bundled into the SDK but never called. It is
removed once the engine binding replaces it, together with the kernel-only exports in
`crates/medha-napi`.

```yojana:claim
kind: path
expression: medha-core/src/rust-bridge.ts
expect: false
```

## Requirement: the CLI keeps running the Rust binary directly {#req-cli-direct}

The published CLI does not go through the SDK. Routing it through Node and the addon would bring
back the startup cost ADR-0001 removed (about 27 ms for the binary, against 200 ms or more with a JS
runtime in front), which matters for hooks that spawn `medha` on every call. Both surfaces meet at
`crates/medha`, not at the SDK.

The TypeScript CLI in `cli/src` stays the reference and the parity spec until the TypeScript engine
is retired.

```yojana:claim
kind: text
expression: /spawnSync\(/ in cli/bin/medha.cjs
```

## Requirement: the default flips behind a gate {#req-gate}

The SDK defaults to the Rust engine only when all of these hold: `test:sdk-parity` is green, the
engine parity test is green, and a black-box run of the packed release (the 30-step scenario,
interop with the CLI, strict `tsc`) matches. The flip is its own release, noted in the changelog
with `MEDHA_ENGINE=typescript` as the way back.

```yojana:claim
kind: text
expression: /MEDHA_ENGINE/ in CHANGELOG.md
```
