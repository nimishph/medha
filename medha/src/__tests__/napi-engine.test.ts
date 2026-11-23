import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type EntityKey, mulberry32, type SeededRng } from '@cntxt-labs/medha-core';
import { MemoryStore } from '@cntxt-labs/medha-store';
import { Medha } from '../engine.ts';

/**
 * The NAPI engine binding (`crates/medha-napi`, ADR-0002) against the TypeScript engine.
 *
 * The SDK will run on the binding, so for every operation it exposes, the binding must answer as
 * the TypeScript `Medha` does: the same value, in the same shape, or the same error (`name`,
 * `code`, `message`). Each seed runs one random script of writes against both engines, compares
 * every outcome, then compares `hints`, `list` and `show` for every key at two later times.
 *
 * Build the addon with `cargo build -p medha-napi`. Without it these tests are skipped, unless
 * `MEDHA_REQUIRE_NATIVE=1`, where a missing or stale addon is a failure.
 */

const ROOT = join(import.meta.dir, '..', '..', '..');
const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;
const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1);

// ---------------------------------------------------------------------------------------------
// the addon
// ---------------------------------------------------------------------------------------------

type Envelope = { ok: true; value: unknown } | { ok: false; error: Record<string, unknown> };

interface NapiEngine {
  call(op: string, args?: unknown): Promise<Envelope>;
}

interface NapiModule {
  NapiEngine: new () => NapiEngine;
}

function addonPath(): string | undefined {
  const names = ['medha_napi.dll', 'libmedha_napi.so', 'libmedha_napi.dylib'];
  for (const profile of ['debug', 'release']) {
    for (const name of names) {
      const path = join(ROOT, 'target', profile, name);
      if (existsSync(path)) return path;
    }
  }
  return undefined;
}

function newestSource(): number {
  let newest = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.rs')) newest = Math.max(newest, statSync(path).mtimeMs);
    }
  };
  for (const crate of ['medha', 'medha-core', 'medha-store', 'medha-cli', 'medha-napi']) {
    walk(join(ROOT, 'crates', crate, 'src'));
  }
  return newest;
}

function loadAddon(): NapiModule | string {
  const path = addonPath();
  if (path === undefined) return 'no addon: run `cargo build -p medha-napi`';
  if (statSync(path).mtimeMs < newestSource()) {
    return `stale addon at ${path}: run \`cargo build -p medha-napi\``;
  }
  const module = { exports: {} as NapiModule };
  process.dlopen(module, path);
  return module.exports;
}

const loaded = loadAddon();
const required = process.env.MEDHA_REQUIRE_NATIVE === '1';
const addon = typeof loaded === 'string' ? undefined : loaded;

// ---------------------------------------------------------------------------------------------
// scripts
// ---------------------------------------------------------------------------------------------

type Op =
  | {
      readonly op: 'record';
      readonly key: EntityKey;
      readonly signal: string;
      readonly ensure: boolean;
      readonly author?: string;
      readonly note?: string;
      readonly now: number;
    }
  | {
      readonly op: 'reportGuard';
      readonly key: EntityKey;
      readonly ok: boolean;
      readonly kind?: string;
      readonly now: number;
    }
  | {
      readonly op: 'define';
      readonly key: EntityKey;
      readonly title: string;
      readonly rationale: string;
      readonly tags?: string[];
      readonly now: number;
    };

const IDS = ['a', 'b', 'c', 'd', ''];
const KINDS = ['rule', 'rule', 'rule', 'recipe', 'tool', 'widget'];
const NAMESPACES = ['', '', 'team'];
const SIGNALS = ['APPLY', 'APPLY', 'APPLY', 'REJECT_RULE', 'REJECT_CONTEXT', 'SKIP', 'BOGUS'];
const GUARDS = ['ci', 'review', 'tests', undefined];

function pick<T>(rng: SeededRng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T;
}

function script(seed: number): { ops: Op[]; end: number } {
  const rng = mulberry32(seed);
  const ops: Op[] = [];
  let now = T0;
  const length = 10 + Math.floor(rng() * 40);
  for (let i = 0; i < length; i++) {
    now += Math.floor(rng() * 48 * HOUR);
    const key: EntityKey = {
      namespace: pick(rng, NAMESPACES),
      kind: pick(rng, KINDS),
      id: pick(rng, IDS),
    };
    const roll = rng();
    if (roll < 0.7) {
      ops.push({
        op: 'record',
        key,
        signal: pick(rng, SIGNALS),
        ensure: rng() < 0.8,
        ...(rng() < 0.3 ? { author: pick(rng, ['alice', 'bob']) } : {}),
        ...(rng() < 0.2 ? { note: `note ${i}` } : {}),
        now,
      });
    } else if (roll < 0.9) {
      const kind = pick(rng, GUARDS);
      ops.push({
        op: 'reportGuard',
        key,
        ok: rng() < 0.7,
        ...(kind === undefined ? {} : { kind }),
        now,
      });
    } else {
      ops.push({
        op: 'define',
        key,
        title: `title ${i}`,
        rationale: `why ${i}`,
        ...(rng() < 0.5 ? { tags: ['x', 'y'] } : {}),
        now,
      });
    }
  }
  return { ops, end: now };
}

// ---------------------------------------------------------------------------------------------
// running both engines
// ---------------------------------------------------------------------------------------------

/** An outcome both engines can be compared on: the value, or the error's identity. */
type Outcome = { value: unknown } | { error: { name: unknown; code: unknown; message: unknown } };

async function ts<T>(run: () => Promise<T>): Promise<Outcome> {
  try {
    return { value: JSON.parse(JSON.stringify(await run())) };
  } catch (err) {
    const e = err as { name?: unknown; code?: unknown; message?: unknown };
    return { error: { name: e.name, code: e.code, message: e.message } };
  }
}

async function rs(engine: NapiEngine, op: string, args: unknown): Promise<Outcome> {
  const out = await engine.call(op, args);
  if (out.ok) return { value: out.value };
  const { name, code, message } = out.error;
  return { error: { name, code, message } };
}

async function runTs(medha: Medha, op: Op): Promise<Outcome> {
  const context = { now: op.now };
  switch (op.op) {
    case 'record':
      return ts(() =>
        medha.record(op.key, op.signal, context, {
          ensure: op.ensure,
          ...(op.author === undefined ? {} : { author: op.author }),
          ...(op.note === undefined ? {} : { note: op.note }),
        }),
      );
    case 'reportGuard':
      return ts(() =>
        medha.reportGuard(
          op.key,
          { ok: op.ok, ...(op.kind === undefined ? {} : { kind: op.kind }) },
          context,
        ),
      );
    case 'define':
      return ts(() =>
        medha.define(
          op.key,
          {
            title: op.title,
            rationale: op.rationale,
            ...(op.tags === undefined ? {} : { tags: op.tags }),
          },
          context,
        ),
      );
  }
}

async function runRs(engine: NapiEngine, op: Op): Promise<Outcome> {
  switch (op.op) {
    case 'record':
      return rs(engine, 'record', op);
    case 'reportGuard':
      return rs(engine, 'reportGuard', op);
    case 'define':
      return rs(engine, 'define', {
        key: op.key,
        definition: {
          title: op.title,
          rationale: op.rationale,
          ...(op.tags === undefined ? {} : { tags: op.tags }),
        },
        now: op.now,
      });
  }
}

async function pair(): Promise<{ medha: Medha; engine: NapiEngine }> {
  const medha = new Medha({ store: new MemoryStore() });
  const engine = new (addon as NapiModule).NapiEngine();
  const opened = await engine.call('memory', {});
  expect(opened.ok ? 'open' : opened.error).toBe('open');
  return { medha, engine };
}

// ---------------------------------------------------------------------------------------------
// the tests
// ---------------------------------------------------------------------------------------------

describe.skipIf(addon === undefined && !required)(
  'NAPI engine binding vs the TypeScript engine',
  () => {
    test('the addon is built and current', () => {
      expect(typeof loaded === 'string' ? loaded : 'ok').toBe('ok');
    });

    test('a closed handle and an unknown operation are refused as data', async () => {
      const engine = new (addon as NapiModule).NapiEngine();
      expect(await rs(engine, 'hints', { keys: [], now: T0 })).toEqual({
        error: {
          name: 'EngineClosedError',
          code: 'SDK_ENGINE_CLOSED',
          message: 'the native engine is not open',
        },
      });
      await engine.call('memory', {});
      const unknown = await rs(engine, 'nope', {});
      expect('error' in unknown && unknown.error.code).toBe('SDK_UNSUPPORTED_OPERATION');
    });

    test.each(SEEDS)('seed %i: every write, then hints, list and show, agree', async (seed) => {
      const { ops, end } = script(seed);
      const { medha, engine } = await pair();
      for (const [index, op] of ops.entries()) {
        const expected = await runTs(medha, op);
        const actual = await runRs(engine, op);
        expect({ seed, index, op, outcome: actual }).toEqual({
          seed,
          index,
          op,
          outcome: expected,
        });
      }
      const keys = ops.map((op) => op.key);
      for (const now of [end, end + 30 * 24 * HOUR]) {
        const context = { now };
        expect(await rs(engine, 'hints', { keys, now })).toEqual(
          await ts(async () => [...(await medha.hints(keys, context)).values()]),
        );
        expect(await rs(engine, 'list', { now })).toEqual(
          await ts(async () => (await medha.list({}, context)).items),
        );
        expect(
          await rs(engine, 'list', { filter: { kind: 'rule', status: 'probation' }, now }),
        ).toEqual(
          await ts(
            async () => (await medha.list({ kind: 'rule', status: 'probation' }, context)).items,
          ),
        );
        for (const key of keys) {
          expect({ key, show: await rs(engine, 'show', { key, now }) }).toEqual({
            key,
            show: await ts(() => medha.show(key, context)),
          });
        }
      }
    });
  },
);
