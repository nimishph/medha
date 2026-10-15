import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildHint,
  type EntityKey,
  type EntityState,
  type Episode,
  episodeToInput,
  foldLog,
  KindRegistry,
  mulberry32,
  type SeededRng,
  SignalRegistry,
  validateEpisodeInput,
} from '@cntxt-labs/medha-core';
import { MemoryStore } from '@cntxt-labs/medha-store';
import { Medha } from '../engine.ts';

/**
 * Cross-engine parity (medha-50q.6). The TypeScript and Rust engines open the same
 * `.medha/store.sqlite`, so they must agree on three things, each checked here against the same
 * seeded operation scripts:
 *
 * 1. Same operations, same outcome: which ops are accepted, the folded states, and the hints.
 * 2. The Rust engine reads every episode the TypeScript engine writes, and folds it the same.
 * 3. The TypeScript engine reads every episode the Rust engine writes, and folds it the same.
 *
 * The TypeScript engine is the reference (it ships, and the spec vectors name its kernel the
 * reference runner). The Rust side runs through `crates/medha/examples/parity_driver.rs`; build it
 * with `cargo build -p medha --example parity_driver`. Without it these tests are skipped, unless
 * `MEDHA_REQUIRE_PARITY=1` (CI), where a missing or stale driver is a failure.
 *
 * A failure prints the seed and a shrunk script, so it can be replayed.
 *
 * Not generated yet, because the engines still differ there (each has a bead): per-kind specs
 * (medha-50q.7), decision trees and `caseId` signals (medha-50q.10), sweep and compaction
 * (medha-50q.11), and CLI `--json` output (medha-50q.9). Both engines agree on, but the reference
 * is questionable for, retraction and the EMA (medha-50q.8).
 */

const ROOT = join(import.meta.dir, '..', '..', '..');
const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;
const SEEDS = Array.from({ length: 150 }, (_, i) => i + 1);

// ---------------------------------------------------------------------------------------------
// the driver
// ---------------------------------------------------------------------------------------------

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(path));
    else if (entry.name.endsWith('.rs')) newest = Math.max(newest, statSync(path).mtimeMs);
  }
  return newest;
}

/** The newest source the driver is built from (cargo does not relink it for a test-only edit). */
function newestDriverSource(): number {
  const crates = ['medha', 'medha-core', 'medha-store', 'medha-sync'];
  const sources = crates.map((name) => newestMtime(join(ROOT, 'crates', name, 'src')));
  const driverSource = join(ROOT, 'crates', 'medha', 'examples', 'parity_driver.rs');
  return Math.max(...sources, statSync(driverSource).mtimeMs);
}

/** The driver binary, or why it cannot be used. */
function locateDriver(): { readonly path: string } | { readonly problem: string } {
  const fromEnv = process.env.MEDHA_PARITY_DRIVER;
  if (fromEnv !== undefined && fromEnv !== '') return { path: fromEnv };
  const exe = process.platform === 'win32' ? 'parity_driver.exe' : 'parity_driver';
  const found = ['debug', 'release']
    .map((profile) => join(ROOT, 'target', profile, 'examples', exe))
    .filter((path) => existsSync(path))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (found === undefined) {
    return { problem: 'no parity driver; run `cargo build -p medha --example parity_driver`' };
  }
  // A driver older than the Rust sources would test yesterday's engine and report it as today's.
  if (statSync(found).mtimeMs < newestDriverSource()) {
    return {
      problem: `${found} is older than the Rust sources; rebuild it with \`cargo build -p medha --example parity_driver\``,
    };
  }
  return { path: found };
}

const driver = locateDriver();
const required = process.env.MEDHA_REQUIRE_PARITY === '1';

// ---------------------------------------------------------------------------------------------
// operation scripts
// ---------------------------------------------------------------------------------------------

type Op =
  | {
      readonly op: 'record';
      readonly key: EntityKey;
      readonly signal: string;
      readonly at: number;
      readonly ensure: boolean;
      readonly anchor?: { readonly kind: string; readonly value: string };
      readonly note?: string;
    }
  | {
      readonly op: 'guard';
      readonly key: EntityKey;
      readonly ok: boolean;
      readonly kind?: string;
      readonly note?: string;
      readonly at: number;
    }
  | {
      readonly op: 'override';
      readonly key: EntityKey;
      readonly action: 'retire' | 'quarantine' | 'restore';
      readonly reason: string;
      readonly at: number;
    }
  | { readonly op: 'retract'; readonly seq: number; readonly reason: string; readonly at: number }
  | {
      readonly op: 'propose';
      readonly key: EntityKey;
      readonly provenance: string;
      readonly theta0?: number;
      readonly at: number;
    }
  | {
      readonly op: 'define';
      readonly key: EntityKey;
      readonly title: string;
      readonly rationale: string;
      readonly tags?: readonly string[];
      readonly at: number;
    };

interface Script {
  readonly ops: readonly Op[];
  readonly now: number;
}

const KEYS: readonly EntityKey[] = [
  { namespace: '', kind: 'rule', id: 'a' },
  { namespace: '', kind: 'rule', id: 'b' },
  { namespace: 'team', kind: 'tool', id: 'c' },
];
const SIGNALS = ['APPLY', 'APPLY', 'APPLY', 'REJECT_RULE', 'REJECT_CONTEXT', 'SKIP'] as const;

const pick = <T>(rng: SeededRng, items: readonly T[]): T =>
  items[Math.floor(rng() * items.length)] as T;

/**
 * A script whose every op appends exactly one episode in both engines (no op is invalid by
 * construction), so op `i` is episode `seq i` and a retraction can name any earlier op.
 */
function generate(seed: number): Script {
  const rng = mulberry32(seed);
  const length = 4 + Math.floor(rng() * 36);
  const ops: Op[] = [];
  let at = T0;
  for (let i = 0; i < length; i++) {
    at += Math.floor(rng() * 72) * HOUR + 1;
    const key = pick(rng, KEYS);
    const roll = rng();
    const note = rng() < 0.2 ? `note ${i}` : undefined;
    if (roll < 0.52) {
      // A few git heads, so durability sees repeated as well as distinct anchors.
      const anchor =
        rng() < 0.3 ? { kind: 'git', value: `sha-${Math.floor(rng() * 4)}` } : undefined;
      ops.push({
        op: 'record',
        key,
        signal: pick(rng, SIGNALS),
        at,
        ensure: rng() < 0.75,
        ...(anchor === undefined ? {} : { anchor }),
        ...(note === undefined ? {} : { note }),
      });
    } else if (roll < 0.68) {
      const kind = pick(rng, ['ci', 'review', undefined]);
      ops.push({
        op: 'guard',
        key,
        ok: rng() < 0.8,
        at,
        ...(kind === undefined ? {} : { kind }),
        ...(note === undefined ? {} : { note }),
      });
    } else if (roll < 0.72) {
      const tags = rng() < 0.5 ? ['b-tag', 'a-tag'] : undefined;
      ops.push({
        op: 'define',
        key,
        title: `title ${i}`,
        rationale: `why ${i}`,
        at,
        ...(tags === undefined ? {} : { tags }),
      });
    } else if (roll < 0.8) {
      const action = pick(rng, ['retire', 'quarantine', 'restore'] as const);
      ops.push({ op: 'override', key, action, reason: `override ${i}`, at });
    } else if (roll < 0.87 && i > 0) {
      ops.push({ op: 'retract', seq: Math.floor(rng() * i), reason: `retract ${i}`, at });
    } else {
      const theta0 = rng() < 0.5 ? Math.round(rng() * 100) / 100 : undefined;
      ops.push({
        op: 'propose',
        key,
        provenance: pick(rng, ['review', 'miner']),
        at,
        ...(theta0 === undefined ? {} : { theta0 }),
      });
    }
  }
  return { ops, now: at + Math.floor(rng() * 60 * 24) * HOUR };
}

/** The script without op `j`; retractions keep pointing at the same op where it survives. */
function withoutOp(script: Script, j: number): Script {
  const ops: Op[] = [];
  for (const [i, op] of script.ops.entries()) {
    if (i === j) continue;
    if (op.op !== 'retract') {
      ops.push(op);
      continue;
    }
    if (op.seq === j) continue;
    ops.push({ ...op, seq: op.seq > j ? op.seq - 1 : op.seq });
  }
  return { ops, now: script.now };
}

// ---------------------------------------------------------------------------------------------
// the two engines
// ---------------------------------------------------------------------------------------------

interface EngineRun {
  readonly results: readonly string[];
  readonly log: readonly unknown[];
  readonly states: readonly unknown[];
  readonly hints: readonly unknown[];
}

async function runTs(script: Script): Promise<EngineRun> {
  const store = new MemoryStore();
  const medha = new Medha({ store });
  const results: string[] = [];
  for (const op of script.ops) {
    const ctx = { now: op.at };
    try {
      switch (op.op) {
        case 'record':
          await medha.record(op.key, op.signal, ctx, {
            ensure: op.ensure,
            ...(op.anchor === undefined ? {} : { anchor: op.anchor }),
            ...(op.note === undefined ? {} : { note: op.note }),
          });
          break;
        case 'guard':
          await medha.reportGuard(
            op.key,
            {
              ok: op.ok,
              ...(op.kind === undefined ? {} : { kind: op.kind }),
              ...(op.note === undefined ? {} : { note: op.note }),
            },
            ctx,
          );
          break;
        case 'define':
          await medha.define(
            op.key,
            {
              title: op.title,
              rationale: op.rationale,
              ...(op.tags === undefined ? {} : { tags: op.tags }),
            },
            ctx,
          );
          break;
        case 'override':
          await medha.override(op.key, op.action, ctx, op.reason);
          break;
        case 'retract':
          await medha.retract(op.seq, op.reason, ctx);
          break;
        case 'propose':
          await medha.propose(
            {
              key: op.key,
              provenance: op.provenance,
              ...(op.theta0 === undefined ? {} : { theta0: op.theta0 }),
            },
            ctx,
          );
          break;
      }
      results.push('ok');
    } catch (failure) {
      results.push(`error: ${(failure as Error).message}`);
    }
  }
  const states = await store.list();
  const hints = await medha.hints(
    states.map((s) => s.key),
    { now: script.now },
  );
  return { results, log: await store.episodes(), states, hints: [...hints.values()] };
}

interface RustLogRead {
  readonly errors: readonly { readonly index: number; readonly error: string }[];
  readonly states: readonly unknown[];
  readonly hints: readonly unknown[];
  readonly fatal?: string;
}

interface DriverResponse {
  readonly scripts: readonly (EngineRun & { readonly fatal?: string })[];
  readonly logs: readonly RustLogRead[];
}

/** One driver call; a driver that cannot run is reported, not thrown. */
function runRust(request: {
  readonly scripts?: readonly Script[];
  readonly logs?: readonly { readonly episodes: readonly unknown[]; readonly now: number }[];
}): DriverResponse | { readonly failure: string } {
  if (!('path' in driver)) return { failure: driver.problem };
  const child = Bun.spawnSync({
    cmd: [driver.path],
    stdin: Buffer.from(JSON.stringify(request)),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (child.exitCode !== 0) {
    return { failure: `parity driver exited ${child.exitCode}: ${child.stderr.toString()}` };
  }
  return JSON.parse(child.stdout.toString()) as DriverResponse;
}

// ---------------------------------------------------------------------------------------------
// normalisation: each engine's own shape -> one comparable shape
// ---------------------------------------------------------------------------------------------

type Loose = Record<string, unknown>;
const field = (o: Loose, ...names: string[]): unknown => {
  for (const name of names) if (o[name] !== undefined) return o[name];
  return null;
};
const keyString = (k: Loose): string => `${k.namespace}/${k.kind}/${k.id}`;

function normState(raw: unknown) {
  const s = raw as Loose;
  const evidence = s.evidence as Loose;
  const ema = s.ema as Loose;
  const guard = s.guard as Loose;
  return {
    key: keyString(s.key as Loose),
    k: evidence.k,
    n: evidence.n,
    contextRejects: field(evidence, 'contextRejects', 'context_rejects'),
    mu: ema.mu,
    theta0: ema.theta0,
    guardKind: guard.kind,
    lastOk: field(guard, 'lastOk', 'last_ok'),
    lastOkAt: field(guard, 'lastOkAt', 'last_ok_at'),
    anchors: ((s.anchors as Loose[]) ?? []).map((a) => `${a.kind}:${a.value}`).sort(),
    status: s.status,
    override: field(s, 'override', 'status_override'),
    lastSignalAt: field(s, 'lastSignalAt', 'last_signal_at'),
    retiredAt: field(s, 'retiredAt', 'retired_at'),
    restoredAt: field(s, 'restoredAt', 'restored_at'),
    createdAt: field(s, 'createdAt', 'created_at'),
    lastNote: field(s, 'lastNote', 'last_note'),
    updater: s.updater,
  };
}

function normHint(raw: unknown) {
  const h = raw as Loose;
  if ('trustScore' in h) {
    const c = h.components as Loose;
    return {
      key: keyString(h.key as Loose),
      trust: h.trustScore,
      status: h.status,
      wilson: c.wilson,
      guard: c.guard,
      recency: c.recency,
      durability: c.durability,
      ceiling: c.ceiling,
      drifting: (h.temporal as Loose).isDrifting,
    };
  }
  const b = h.breakdown as Loose;
  return {
    key: keyString(h.key as Loose),
    trust: h.trust,
    status: h.status,
    wilson: field(b, 'wilsonLower', 'wilson_lower'),
    guard: field(b, 'guardFactor', 'guard_factor'),
    recency: b.recency,
    durability: b.durability,
    ceiling: field(b, 'effectiveCeiling', 'effective_ceiling'),
    drifting: field(h, 'isDrifting', 'is_drifting'),
  };
}

const byKey = <T extends { readonly key: string }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

/** The first difference between two comparable values, as a path and the two sides. */
function firstDifference(ts: unknown, rust: unknown, path = ''): string | null {
  if (Object.is(ts, rust)) return null;
  if (typeof ts === 'number' && typeof rust === 'number' && Math.abs(ts - rust) <= 1e-9) {
    return null;
  }
  if (Array.isArray(ts) && Array.isArray(rust)) {
    if (ts.length !== rust.length) {
      return `${path || '(root)'}: ts has ${ts.length} items, rust has ${rust.length}`;
    }
    for (let i = 0; i < ts.length; i++) {
      const d = firstDifference(ts[i], rust[i], `${path}[${i}]`);
      if (d !== null) return d;
    }
    return null;
  }
  if (ts !== null && rust !== null && typeof ts === 'object' && typeof rust === 'object') {
    const a = ts as Loose;
    const b = rust as Loose;
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDifference(a[name], b[name], path === '' ? name : `${path}.${name}`);
      if (d !== null) return d;
    }
    return null;
  }
  return `${path || '(root)'}: ts ${JSON.stringify(ts)} vs rust ${JSON.stringify(rust)}`;
}

// ---------------------------------------------------------------------------------------------
// the three properties
// ---------------------------------------------------------------------------------------------

/** Property 1: the same script, run by each engine. */
function compareRuns(ts: EngineRun, rust: EngineRun & { readonly fatal?: string }): string | null {
  if (rust.fatal !== undefined) return `rust driver: ${rust.fatal}`;
  // Errors are compared by acceptance only: the two engines word their messages differently.
  const accepted = (r: readonly string[]) => r.map((x) => (x === 'ok' ? 'ok' : 'error'));
  return (
    firstDifference(accepted(ts.results), accepted(rust.results), 'accepted') ??
    firstDifference(byKey(ts.states.map(normState)), byKey(rust.states.map(normState)), 'states') ??
    firstDifference(byKey(ts.hints.map(normHint)), byKey(rust.hints.map(normHint)), 'hints')
  );
}

/** Property 2: the Rust engine reading the log the TypeScript engine wrote. */
function compareRustRead(ts: EngineRun, read: RustLogRead): string | null {
  if (read.fatal !== undefined) return `rust driver: ${read.fatal}`;
  const unreadable = read.errors[0];
  if (unreadable !== undefined) {
    const episode = ts.log[unreadable.index] as Loose;
    return `rust cannot read ts episode seq ${episode.seq} (${episode.type}): ${unreadable.error}`;
  }
  return (
    firstDifference(byKey(ts.states.map(normState)), byKey(read.states.map(normState)), 'states') ??
    firstDifference(byKey(ts.hints.map(normHint)), byKey(read.hints.map(normHint)), 'hints')
  );
}

/** Property 3: the TypeScript kernel reading the log the Rust engine wrote. */
function compareTsRead(rust: EngineRun & { readonly fatal?: string }, now: number): string | null {
  if (rust.fatal !== undefined) return `rust driver: ${rust.fatal}`;
  const validation = { kinds: new KindRegistry(), signals: new SignalRegistry() };
  const log = rust.log as Episode[];
  for (const episode of log) {
    try {
      validateEpisodeInput(episodeToInput(episode), validation);
    } catch (failure) {
      return `ts cannot read rust episode seq ${episode.seq} (${episode.type}): ${(failure as Error).message}`;
    }
  }
  let states: EntityState[];
  try {
    states = foldLog(log, validation.kinds);
  } catch (failure) {
    return `ts cannot fold the rust log: ${(failure as Error).message}`;
  }
  return (
    firstDifference(byKey(states.map(normState)), byKey(rust.states.map(normState)), 'states') ??
    firstDifference(
      byKey(states.map((s) => normHint(buildHint(s, now)))),
      byKey(rust.hints.map(normHint)),
      'hints',
    )
  );
}

/**
 * Run a property over every seed (the Rust side in one driver call) and return the first
 * divergence, or null. A failing script is shrunk one op at a time while it keeps failing, so the
 * report is the smallest script found, with the seed it came from.
 */
async function firstDivergence(
  property: (scripts: readonly Script[], ts: readonly EngineRun[]) => (string | null)[],
): Promise<string | null> {
  const evaluate = async (scripts: readonly Script[]) => {
    const ts = await Promise.all(scripts.map(runTs));
    return property(scripts, ts);
  };
  const scripts = SEEDS.map(generate);
  const outcomes = await evaluate(scripts);
  const failing = outcomes.findIndex((o) => o !== null);
  if (failing === -1) return null;

  let script = scripts[failing] as Script;
  let reason = outcomes[failing] as string;
  for (;;) {
    const candidates = script.ops.map((_, j) => withoutOp(script, j));
    if (candidates.length === 0) break;
    const shrunk = await evaluate(candidates);
    const next = shrunk.findIndex((o) => o !== null);
    if (next === -1) break;
    script = candidates[next] as Script;
    reason = shrunk[next] as string;
  }
  return (
    `seed ${SEEDS[failing]} diverges: ${reason}\n` +
    `shrunk to ${script.ops.length} ops:\n${JSON.stringify(script, null, 1)}`
  );
}

type ScriptRun = DriverResponse['scripts'][number];

describe.skipIf(!('path' in driver))('TS/Rust engine parity (medha-50q.6)', () => {
  test('the same op scripts give the same accepted ops, states and hints', async () => {
    const divergence = await firstDivergence((scripts, ts) => {
      const rust = runRust({ scripts });
      if ('failure' in rust) return scripts.map(() => rust.failure);
      return scripts.map((_, i) => compareRuns(ts[i] as EngineRun, rust.scripts[i] as ScriptRun));
    });
    expect(divergence).toBeNull();
  });

  test('Rust reads every episode the TS engine writes and folds it the same', async () => {
    const divergence = await firstDivergence((scripts, ts) => {
      const logs = scripts.map((s, i) => ({ episodes: ts[i]?.log ?? [], now: s.now }));
      const rust = runRust({ logs });
      if ('failure' in rust) return scripts.map(() => rust.failure);
      return scripts.map((_, i) =>
        compareRustRead(ts[i] as EngineRun, rust.logs[i] as RustLogRead),
      );
    });
    expect(divergence).toBeNull();
  });

  test('TS reads every episode the Rust engine writes and folds it the same', async () => {
    const divergence = await firstDivergence((scripts) => {
      const rust = runRust({ scripts });
      if ('failure' in rust) return scripts.map(() => rust.failure);
      return scripts.map((s, i) => compareTsRead(rust.scripts[i] as ScriptRun, s.now));
    });
    expect(divergence).toBeNull();
  });
});

describe('parity driver availability', () => {
  test.if(required)('the parity driver is built and current (MEDHA_REQUIRE_PARITY=1)', () => {
    expect('path' in driver ? 'ok' : driver.problem).toBe('ok');
  });
});
