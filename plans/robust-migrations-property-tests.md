---
id: plan/robust-migrations-property-tests
title: 'Robust: Migrations, Property Tests, and Differential Parity'
status: accepted
beads: [medha-50q]
---

# Robust: Migrations, Property Tests, and Differential Parity

Establish provable mathematical invariants and migration safety across both TypeScript and Rust implementations of Medha. This plan covers trust formula monotonicity, model-based reachable state exploration, versioned snapshot migrations, engine differential parity, per-kind configuration handling, retraction semantics, and maintenance plane alignment.

Out of scope:
- Full deprecation or migration of the TypeScript CLI to pure Rust (covered in ADR-0001 / epic `medha-dvv`).
- Cryptographic episode signing and author isolation (covered in epic `medha-nwf`).

## Requirement: trust monotonicity and invariants hold across reachable states {#req-trust-property-tests beads=medha-50q.2,medha-50q.3}

Trust math adheres to monotonicity and invariant properties verified through deterministic property-based and model-based tests. The Wilson score interval lower bound must be monotonically non-decreasing with respect to successes for fixed trials; successes must never decrease trust, and failures must never increase trust. Random reachable state exploration must verify trust values remain within $[0, 1]$, unguarded entities remain capped below their ceiling, terminal lifecycle states score 0, and no entity can reach `trusted` status without an automated guard passing.

```yojana:claim
kind: path
expression: medha-core/src/__tests__/properties.test.ts
```

```yojana:claim
kind: text
expression: component monotonicity in medha-core/src/__tests__/properties.test.ts
```

```yojana:claim
kind: text
expression: bounds and invariants hold for every reachable state in medha-core/src/__tests__/properties.test.ts
```

## Requirement: versioned store snapshots and migration framework {#req-snapshot-migrations beads=medha-50q.4}

Store snapshots must be explicitly versioned and supported by an ordered migration pipeline across both TypeScript and Rust. Ingestion and restoration must parse explicit format versions (`sutras.medha/vN`, `sutras.sage/vN`), detect unversioned legacy snapshots (v0), and execute sequentially registered migration steps to bring store state up to the current schema version without loss of episodes or entities.

```yojana:claim
kind: path
expression: medha/src/snapshot-migrations.ts
```

```yojana:claim
kind: path
expression: crates/medha-sync/tests/snapshot_migration_test.rs
```

```yojana:claim
kind: text
expression: export function extractStoreSnapshotVersion in medha/src/snapshot-migrations.ts
```

```yojana:claim
kind: text
expression: pub fn migrate_snapshot in crates/medha-sync/src/snapshot.rs
```

## Requirement: differential TS and Rust engine parity {#req-engine-parity beads=medha-50q.6}

TypeScript and Rust engines must execute equivalent state operations with identical outcomes. Seeded operation scripts must verify that given identical inputs, both engines agree on accepted vs. rejected operations, can cross-read stored episode logs from each other, and compute equivalent entity states and trust hints at any given evaluation timestamp.

```yojana:claim
kind: path
expression: crates/medha/tests/engine_test.rs
```

```yojana:claim
kind: text
expression: fn test_medha_engine_memory_lifecycle in crates/medha/tests/engine_test.rs
```

## Requirement: Rust engine respects per-kind registries and threshold specifications {#req-rust-kind-specs beads=medha-50q.7}

The Rust store folding and hint calculations must read `registries.kindSpecs` from `.medha/config.json` rather than falling back unconditionally to default thresholds and recency parameters. Custom per-kind thresholds, recency half-life, signal-value weighting, and signal limits must produce identical trust scores and lifecycle statuses in both TypeScript and Rust runtimes.

```yojana:claim
kind: path
expression: crates/medha-core/src/fold.rs
```

```yojana:claim
kind: text
expression: pub struct KindSpec in crates/medha-core/src/fold.rs
```

## Requirement: signal retraction restores post-retraction weight and EMA continuity {#req-retract-weight-consistency beads=medha-50q.8}

Retracting a signal episode (`retract --seq N`) must either recompute subsequent episode weights and EMA $\mu$ values to eliminate pre-retraction influence on downward drift quarantine, or document and enforce consistent 'counts-only' semantics between TypeScript and Rust across log replays.

```yojana:claim
kind: text
expression: applySignal in medha-core/src/fold.ts
```

## Requirement: Rust and TypeScript CLI commands and JSON output parity {#req-cli-parity beads=medha-50q.9}

The Rust CLI must provide parity with the TypeScript CLI for programmatic consumption (`--json`). Output schemas (field names and camelCase conventions), list sorting order (trust score descending), and command surfaces (`retract`, `define`, `decision`, `maintain`, `mcp config`, `ui`, `report`) must match reference TypeScript behavior or be explicitly specified as a distinct CLI subset.

```yojana:claim
kind: path
expression: crates/medha-cli/src/args.rs
```

```yojana:claim
kind: path
expression: cli/src/read.ts
```

## Requirement: maintenance plane sweep rules, compaction, and audit logging {#req-maintenance-plane beads=medha-50q.11,medha-50q.5}

The maintenance plane in Rust must match TypeScript's §8 specifications: session-start sweep must enforce downward-drift quarantine and retention-based archival/purging; compaction must fold episodes older than a cutoff into baseline states with in-memory bake-and-verify fold equivalence before executing log replacement; hard episode removals must record audit entries (`audit:removedEpisodes`); and incoming sync/pull replaces must be validated against registered KindSpecs prior to log replacement.

```yojana:claim
kind: path
expression: medha/src/maintenance.ts
```

```yojana:claim
kind: path
expression: crates/medha/src/maintenance.rs
```

```yojana:claim
kind: text
expression: LAST_SWEEP_META_KEY in medha/src/maintenance.ts
```

## Requirement: decision tree representation and branch evidence folding {#req-decision-trees beads=medha-50q.10}

Decision tree branches and evidence folding must be consistent between TypeScript and Rust. Decision episodes targeting nonexistent entities or invalid branches must be handled predictably, and branch evidence must incorporate kind-weighted evidence rather than unweighted counters.

```yojana:claim
kind: path
expression: crates/medha-core/src/decision.rs
```

```yojana:claim
kind: path
expression: docs/spec/vectors/decision-tree.json
```
