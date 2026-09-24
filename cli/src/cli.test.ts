import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Medha, type MedhaSnapshot, Sage } from '@cntxt-labs/medha';
import type { EntityKey } from '@cntxt-labs/medha-core';
import { MemoryStore } from '@cntxt-labs/medha-store';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { runCli } from './cli.ts';
import type { Environment } from './environment.ts';
import { type MedhaConfigV1, storeForConfig } from './layout.ts';
import { serveMcp } from './mcp.ts';
import { VERSION } from './version.ts';

/**
 * `medha init` acceptance (Loom-ujs3.11.2). Each test gets a throwaway project root; the harness
 * injects a fixed clock so `lastSweep` timestamps and sweep-interval bookkeeping are deterministic.
 */

const NOW = Date.UTC(2026, 8, 23, 0, 0, 0);

let cleanups: readonly string[] = [];

afterEach(() => {
  const dirs = cleanups;
  cleanups = [];
  Bun.gc(true);
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

const BUILTIN_KINDS = ['rule', 'recipe', 'tool'];
const ANCHOR_KINDS = ['week'];

function fresh(): {
  env: Environment;
  root: string;
  home: string;
  out: () => string;
  err: () => string;
  setNow: (now: number) => void;
} {
  const root = join(tmpdir(), `sage-cli-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  cleanups = [...cleanups, root];
  let out = '';
  let err = '';
  let clock = NOW;
  const env: Environment = {
    cwd: root,
    env: {},
    now: () => clock,
    isTTY: false,
    exitCode: 0,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
  };
  return {
    env,
    root,
    home: join(root, '.medha'),
    out: () => out,
    err: () => err,
    setNow: (t: number) => {
      clock = t;
    },
  };
}

function readConfig(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as Record<string, unknown>;
}

describe('sage entrypoint', () => {
  test('--version prints the manifest version and exits 0', async () => {
    const { env, out } = fresh();
    expect(await runCli(['--version'], env)).toBe(0);
    expect(out()).toBe(`medha ${VERSION}\n`);
  });

  test('bare sage prints usage to stderr and exits 2', async () => {
    const { env, err } = fresh();
    expect(await runCli([], env)).toBe(2);
    expect(err()).toContain('init');
  });

  test('sage help prints usage to stdout and exits 0', async () => {
    const { env, out } = fresh();
    expect(await runCli(['help'], env)).toBe(0);
    expect(out()).toContain('USAGE');
    expect(out()).toContain('init');
  });

  test('unknown command is usage (exit 2)', async () => {
    const { env } = fresh();
    expect(await runCli(['frobnicate'], env)).toBe(2);
  });

  test('invalid --store value is usage (exit 2)', async () => {
    const { env } = fresh();
    expect(await runCli(['init', '--store', 'mongo'], env)).toBe(2);
  });

  test('Medha and Sage are identical engine constructors', () => {
    expect(Medha).toBe(Sage);
  });
});

describe('medha init — default sqlite backend', () => {
  test('scaffolds config.json + store.sqlite and reports a healthy preflight', async () => {
    const { env, home, out } = fresh();
    expect(await runCli(['init'], env)).toBe(0);

    expect(existsSync(join(home, 'store.sqlite'))).toBe(true);
    const config = readConfig(home);
    expect(config.layoutVersion).toBe(1);
    expect(config.backend).toBe('sqlite');
    expect(config.path).toBe(join(home, 'store.sqlite'));

    const registries = config.registries as {
      kinds: string[];
      signalSpecs: {
        name: string;
        value: number;
        countsAsTrial: boolean;
        countsAsSuccess: boolean;
      }[];
      anchorKinds: string[];
    };
    expect(registries.kinds).toEqual(BUILTIN_KINDS);
    expect(registries.anchorKinds).toEqual(ANCHOR_KINDS);
    const apply = registries.signalSpecs.find((spec) => spec.name === 'APPLY');
    expect(apply).toMatchObject({ value: 1, countsAsTrial: true, countsAsSuccess: true });

    expect(out()).toContain('preflight:  ok');
    expect(out()).toContain(join(home, 'store.sqlite'));
  });

  test('json output round-trips the report', async () => {
    const { env, root, out } = fresh();
    expect(await runCli(['init', '--json'], env)).toBe(0);
    const report = JSON.parse(out()) as {
      home: string;
      backend: string;
      preflight: { status: string };
    };
    expect(report.home).toBe(join(root, '.medha'));
    expect(report.backend).toBe('sqlite');
    expect(report.preflight.status).toBe('ok');
  });
});

describe('medha init — backends and paths', () => {
  test('file backend writes the state.jsonl document file', async () => {
    const { env, home } = fresh();
    expect(await runCli(['init', '--store', 'file'], env)).toBe(0);
    expect(existsSync(join(home, 'state.jsonl'))).toBe(true);
    expect(readConfig(home).path).toBe(join(home, 'state.jsonl'));
    // .bak exists only after a second atomic write; a fresh init has exactly the main doc.
    expect(existsSync(join(home, 'state.jsonl.bak'))).toBe(false);
  });

  test('<command> --help prints usage and never runs the command', async () => {
    const { env, root, out } = fresh();
    expect(await runCli(['init', '--help'], env)).toBe(0);
    expect(out()).toContain('--store');
    expect(existsSync(join(root, '.medha'))).toBe(false);
    expect(await runCli(['maintain', 'backup', '--help'], env)).toBe(0);
  });

  test('default init writes .medha and never touches .sutra', async () => {
    const { env, root } = fresh();
    expect(await runCli(['init'], env)).toBe(0);
    expect(existsSync(join(root, '.medha', 'config.json'))).toBe(true);
    expect(existsSync(join(root, '.sutra'))).toBe(false);
  });

  test('--home opts in to another home, and reads follow it', async () => {
    const { env, root } = fresh();
    expect(await runCli(['init', '--home', '.sutra/sage'], env)).toBe(0);
    expect(existsSync(join(root, '.sutra', 'sage', 'config.json'))).toBe(true);
    expect(existsSync(join(root, '.medha'))).toBe(false);
    expect(await runCli(['status', '--home', '.sutra/sage'], env)).toBe(0);
    expect(await runCli(['status'], env)).not.toBe(0);
  });

  test('memory backend persists nothing', async () => {
    const { env, root, out } = fresh();
    expect(await runCli(['init', '--store', 'memory'], env)).toBe(0);
    expect(existsSync(join(root, '.medha'))).toBe(false);
    expect(out()).toContain('ephemeral (memory)');
    expect(out()).toContain('preflight:  ok');
  });

  test('--path overrides the default store location', async () => {
    const { env, root, home } = fresh();
    const path = join(root, 'db', 'alt.sqlite');
    expect(await runCli(['init', '--path', path], env)).toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(readConfig(home).path).toBe(path);
  });

  test('--path with the memory backend is usage (exit 2)', async () => {
    const { env, err } = fresh();
    expect(await runCli(['init', '--store', 'memory', '--path', 'nowhere'], env)).toBe(2);
    expect(err()).toContain('CORE_INVALID_ARGUMENT');
  });
});

describe('medha init — idempotency', () => {
  test('a second init refuses as already-initialized', async () => {
    const { env, err } = fresh();
    await runCli(['init'], env);
    expect(await runCli(['init'], env)).toBe(1);
    expect(err()).toContain('CLI_ALREADY_INITIALIZED');
  });

  test('a matching --config still refuses as already-initialized', async () => {
    const { env, root } = fresh();
    await runCli(['init'], env);
    const cfg = join(root, 'empty.json');
    writeFileSync(cfg, '{}');
    expect(await runCli(['init', '--config', cfg], env)).toBe(1);
  });

  test('a drifting --config is a named registry-drift error, not already-initialized', async () => {
    const { env, root, err } = fresh();
    const first = join(root, 'widget.json');
    writeFileSync(first, JSON.stringify({ kinds: ['widget'] }));
    await runCli(['init', '--config', first], env);

    const second = join(root, 'gadget.json');
    writeFileSync(second, JSON.stringify({ kinds: ['gadget'] }));
    expect(await runCli(['init', '--config', second], env)).toBe(1);
    expect(err()).toContain('CLI_REGISTRY_DRIFT');
    expect(err()).toContain('gadget');
    expect(err()).toContain('widget');
  });

  test('--recreate wipes the store and re-initializes with the fresh --config', async () => {
    const { env, root, home } = fresh();
    const first = join(root, 'widget.json');
    writeFileSync(first, JSON.stringify({ kinds: ['widget'] }));
    await runCli(['init', '--config', first], env);

    const second = join(root, 'gadget.json');
    writeFileSync(second, JSON.stringify({ kinds: ['gadget'] }));
    expect(await runCli(['init', '--config', second, '--recreate'], env)).toBe(0);

    const registries = readConfig(home).registries as { kinds: string[] };
    expect(registries.kinds).toContain('gadget');
    expect(registries.kinds).not.toContain('widget');
  });
});

describe('medha init — registry validation', () => {
  test('an invalid signal spec (value 0 counting as trial) is rejected before any store exists', async () => {
    const { env, root, home, err } = fresh();
    const cfg = join(root, 'bad.json');
    writeFileSync(
      cfg,
      JSON.stringify({
        signalSpecs: [{ name: 'BOGUS', value: 0, countsAsTrial: true, countsAsSuccess: false }],
      }),
    );
    expect(await runCli(['init', '--config', cfg], env)).toBe(1);
    expect(err()).toContain('CORE_INVARIANT_VIOLATED');
    expect(existsSync(join(home, 'store.sqlite'))).toBe(false);
    expect(existsSync(join(home, 'config.json'))).toBe(false);
  });

  test('a duplicate signal spec is rejected', async () => {
    const { env, root, err } = fresh();
    const cfg = join(root, 'dup.json');
    writeFileSync(
      cfg,
      JSON.stringify({
        signalSpecs: [
          { name: 'X', value: 0.5, countsAsTrial: true, countsAsSuccess: true },
          { name: 'X', value: 1, countsAsTrial: true, countsAsSuccess: true },
        ],
      }),
    );
    expect(await runCli(['init', '--config', cfg], env)).toBe(1);
    expect(err()).toContain('CLI_CONFIG_INVALID');
  });

  test('--config additions are additive over built-ins', async () => {
    const { env, root, home } = fresh();
    const cfg = join(root, 'add.json');
    writeFileSync(
      cfg,
      JSON.stringify({
        kinds: ['widget'],
        signalSpecs: [{ name: 'REVIEWED', value: 0.5, countsAsTrial: true, countsAsSuccess: true }],
      }),
    );
    expect(await runCli(['init', '--config', cfg], env)).toBe(0);
    const registries = readConfig(home).registries as {
      kinds: string[];
      signalSpecs: { name: string }[];
      anchorKinds: string[];
    };
    expect(registries.kinds).toEqual([...BUILTIN_KINDS, 'widget']);
    expect(registries.anchorKinds).toEqual(ANCHOR_KINDS);
    expect(registries.signalSpecs.map((spec) => spec.name)).toContain('REVIEWED');
    expect(registries.signalSpecs.map((spec) => spec.name)).toContain('APPLY');
  });
});

describe('medha init — beyond the happy path', () => {
  test('--backup writes a MedhaSnapshot that restores in-process', async () => {
    const { env, root } = fresh();
    const backup = join(root, 'backup.json');
    expect(await runCli(['init', '--backup', backup], env)).toBe(0);

    const parsed = JSON.parse(readFileSync(backup, 'utf8')) as unknown as {
      snapshot: MedhaSnapshot;
    };
    expect(parsed.snapshot.format).toBe('sutras.medha/v1');
    expect(parsed.snapshot.episodes).toEqual([]);

    const store = new MemoryStore({ registries: parsed.snapshot.registries });
    const engine = new Sage({ store });
    await engine.restore(parsed.snapshot);
    const report = await engine.preflight({ now: NOW });
    expect(report.status).toBe('ok');
    await engine.close();
  });

  test('a corrupt file store fails with CLI_STORE_CORRUPT and a usable hint', async () => {
    const { env, home, err } = fresh();
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'state.jsonl'), '{garbage');

    expect(await runCli(['init', '--store', 'file'], env)).toBe(1);
    expect(err()).toContain('CLI_STORE_CORRUPT');
    expect(err()).toContain('hint:');
  });
});

// ---------------------------------------------------------------------------------------------
// Read plane (Loom-ujs3.11.3): seed a real store through storeForConfig + Sage, then drive every
// read command through the CLI. NOW is fixed, so all rendered timestamps and deltas are golden.
// ---------------------------------------------------------------------------------------------

const SEED_NOW = NOW + 1000;

/** Seed a configured home with known entities and return the store file path. */
async function seedHome(env: Environment): Promise<void> {
  const config = readConfig(join(env.cwd, '.medha')) as unknown as MedhaConfigV1;
  const store = storeForConfig(config);
  const engine = new Sage({ store });
  try {
    const key = (id: string): EntityKey => ({ namespace: '', kind: 'rule', id });
    // t1: trusted (9 applies + passing guard), a1: active (5 applies), p1: probation (2 applies),
    // fresh: zero-evidence materialized via SKIP, rest: rejected enough to retire below threshold.
    const apply = (k: EntityKey, at: number) =>
      engine.record(k, 'APPLY', { now: at }, { ensure: true });
    await apply(key('t1'), SEED_NOW + 1);
    await apply(key('t1'), SEED_NOW + 2);
    await apply(key('t1'), SEED_NOW + 3);
    await apply(key('t1'), SEED_NOW + 4);
    await apply(key('t1'), SEED_NOW + 5);
    await apply(key('t1'), SEED_NOW + 6);
    await apply(key('t1'), SEED_NOW + 7);
    await apply(key('t1'), SEED_NOW + 8);
    await apply(key('t1'), SEED_NOW + 9);
    await engine.reportGuard(key('t1'), { ok: true, kind: 'harness' }, { now: SEED_NOW + 10 });
    for (const i of [1, 2, 3, 4, 5]) await apply(key('a1'), SEED_NOW + 100 + i);
    await apply(key('p1'), SEED_NOW + 200);
    await apply(key('p1'), SEED_NOW + 201);
    await engine.record(key('fresh'), 'SKIP', { now: SEED_NOW + 300 }, { ensure: true });
    await engine.record(key('r1'), 'REJECT_RULE', { now: SEED_NOW + 400 }, { ensure: true });
    await engine.record(key('r1'), 'REJECT_RULE', { now: SEED_NOW + 401 }, { ensure: true });
    await engine.record(key('r1'), 'REJECT_RULE', { now: SEED_NOW + 402 }, { ensure: true });
  } finally {
    await engine.close();
  }
}

describe('sage read plane — list', () => {
  test('lists all entities with trust, status, drift, and key labels', async () => {
    const { env, out } = fresh();
    await runCli(['init'], env);
    await seedHome(env);

    expect(await runCli(['list'], env)).toBe(0);
    const text = out();
    expect(text).toContain('5 entities');
    expect(text).toContain('rule/t1');
    expect(text).toContain('trusted');
    expect(text).toContain('rule/a1');
    expect(text).toContain('active');
  });

  test('filters by status and kind', async () => {
    const { env, out } = fresh();
    await runCli(['init'], env);
    await seedHome(env);

    expect(await runCli(['list', '--status', 'trusted'], env)).toBe(0);
    expect(out()).toContain('1 entities');
    expect(out()).toContain('rule/t1');
    expect(out()).not.toContain('rule/a1');

    expect(await runCli(['list', '--kind', 'recipe'], env)).toBe(0);
    expect(out()).toContain('0 entities');
  });

  test('invalid --status is usage (exit 2)', async () => {
    const { env, err } = fresh();
    await runCli(['init'], env);
    await seedHome(env);

    expect(await runCli(['list', '--status', 'bogus'], env)).toBe(2);
    expect(err()).toContain('CORE_INVALID_ARGUMENT');
  });

  test('reads from a --dir home', async () => {
    const { env, root, out } = fresh();
    await runCli(['init', '--dir', root], env);
    await seedHome(env);

    expect(await runCli(['list', '--dir', root], env)).toBe(0);
    expect(out()).toContain('5 entities');
  });

  test('json output round-trips the page shape', async () => {
    const { env, out } = fresh();
    await runCli(['init'], env);
    await seedHome(env);

    const before = out();
    expect(await runCli(['list', '--json'], env)).toBe(0);
    const report = JSON.parse(out().slice(before.length)) as {
      home: string;
      filter: Record<string, unknown>;
      page: { total: number; items: unknown[]; limit: { applied: number; reached: boolean } };
    };
    expect(report.page.total).toBe(5);
    expect(report.page.limit).toMatchObject({ applied: 1000, reached: false });
    expect(report.page.items).toHaveLength(5);
  });
});

describe('sage read plane — show', () => {
  test('shows trust components and clears thresholds for a known entity', async () => {
    const { env, out } = fresh();
    await runCli(['init'], env);
    await seedHome(env);

    expect(await runCli(['show', '--id', 't1'], env)).toBe(0);
    const text = out();
    expect(text).toContain('rule/t1 (known)');
    expect(text).toContain('status:   trusted');
    expect(text).toContain('trust:   ');
    expect(text).toContain('clears:   trusted yes, active yes');
    expect(text).toContain('recent episodes:');
  });

  test('missing --id is usage (exit 2)', async () => {
    const { env, err } = fresh();
    await runCli(['init'], env);
    await seedHome(env);

    expect(await runCli(['show'], env)).toBe(2);
    expect(err()).toContain('CORE_INVALID_ARGUMENT');
  });

  test('--json round-trips the detail', async () => {
    const { env, out } = fresh();
    await runCli(['init'], env);
    await seedHome(env);

    const before = out();
    expect(await runCli(['show', '--id', 'a1', '--json'], env)).toBe(0);
    const report = JSON.parse(out().slice(before.length)) as {
      key: { id: string };
      detail: { known: boolean };
    };
    expect(report.key.id).toBe('a1');
    expect(report.detail.known).toBe(true);
  });
});

describe('sage read plane — status and drift', () => {
  test('status reports preflight, by-status distribution, and drift count', async () => {
    const { env, out } = fresh();
    await runCli(['init'], env);
    await seedHome(env);

    expect(await runCli(['status'], env)).toBe(0);
    const text = out();
    expect(text).toContain('preflight:  ok');
    expect(text).toContain('by status:  probation');
    expect(text).toContain('trusted 1');
    expect(text).toContain('drifting:   ');

    const before = out();
    expect(await runCli(['status', '--json'], env)).toBe(0);
    const report = JSON.parse(out().slice(before.length)) as { preflight: { status: string } };
    expect(report.preflight.status).toBe('ok');
  });

  test('drift lists drifting entities and honors --limit', async () => {
    const { env, out } = fresh();
    await runCli(['init'], env);
    await seedHome(env);

    expect(await runCli(['drift'], env)).toBe(0);
    const text = out();
    expect(text).toContain('entities drifting');
    expect(text).toContain('rule/r1');

    expect(await runCli(['drift', '--limit', '1'], env)).toBe(0);
    const limited = out();
    expect(limited).toContain('limit applied 1');
  });

  test('invalid --limit is usage (exit 2)', async () => {
    const { env, err } = fresh();
    await runCli(['init'], env);
    await seedHome(env);

    expect(await runCli(['drift', '--limit', '0'], env)).toBe(2);
    expect(err()).toContain('CORE_INVALID_ARGUMENT');
  });
});

describe('sage read plane — params, simulate, explain-threshold', () => {
  test('params lists the canonical catalog read-only', async () => {
    const { env, out } = fresh();

    expect(await runCli(['params'], env)).toBe(0);
    const text = out();
    expect(text).toContain('canonical model parameters (read-only)');
    expect(text).toContain('TRUSTED_THRESHOLD');
    expect(text).toContain('DEFAULT_SWEEP_INTERVAL_MS');
    expect(text).toContain('read-only');

    const before = out();
    expect(await runCli(['params', '--json'], env)).toBe(0);
    const report = JSON.parse(out().slice(before.length)) as { params: { name: string }[] };
    expect(report.params.length).toBeGreaterThan(10);
  });

  test('simulate reports the what-if delta and changes nothing', async () => {
    const { env, out } = fresh();
    await runCli(['init'], env);
    await seedHome(env);

    expect(await runCli(['simulate', '--id', 't1', '--signal', 'APPLY'], env)).toBe(0);
    const text = out();
    expect(text).toContain('trust:    ');
    expect(text).toContain('->');

    const before = out();
    expect(await runCli(['show', '--id', 't1', '--json'], env)).toBe(0);
    const after = JSON.parse(out().slice(before.length)) as {
      detail: { hint: { evidence: { totalTrials: number } } };
    };
    expect(after.detail.hint.evidence.totalTrials).toBe(9);
  });

  test('an unknown --signal is an operational error (exit 1)', async () => {
    const { env, err } = fresh();
    await runCli(['init'], env);
    await seedHome(env);

    expect(await runCli(['simulate', '--id', 't1', '--signal', 'NOPE'], env)).toBe(1);
    expect(err()).toContain('CORE_UNKNOWN_REGISTRY_ENTRY');
  });

  test('simulate on a fresh id folds the probation prior', async () => {
    const { env, out } = fresh();
    await runCli(['init'], env);
    await seedHome(env);

    expect(await runCli(['simulate', '--id', 'ghost', '--signal', 'APPLY'], env)).toBe(0);
    expect(out()).toContain('probation');
  });

  test('explain-threshold reports which gates clear and why, never a decision', async () => {
    const { env, out } = fresh();
    await runCli(['init'], env);
    await seedHome(env);

    expect(await runCli(['explain-threshold', '--id', 't1'], env)).toBe(0);
    const text = out();
    expect(text).toContain('thresholds for rule/t1');
    expect(text).toContain('trusted: MET');
    expect(text).toContain('active: MET');
    expect(text).toContain('never decides');

    expect(await runCli(['explain-threshold', '--id', 'fresh'], env)).toBe(0);
    expect(out()).toContain('trusted: not met');
  });
});

describe('sage read plane — home guards', () => {
  test('reads on an uninitialized home fail with CLI_NOT_INITIALIZED (exit 1)', async () => {
    const { env, err } = fresh();
    expect(await runCli(['list'], env)).toBe(1);
    expect(err()).toContain('CLI_NOT_INITIALIZED');
    expect(err()).toContain('init');
  });

  test('a memory home writes no config, so reads fail with CLI_NOT_INITIALIZED (exit 1)', async () => {
    const { env, err } = fresh();
    expect(await runCli(['init', '--store', 'memory'], env)).toBe(0);
    // The memory backend deliberately persists nothing — there is no config.json to reopen,
    // so a subsequent read command sees an uninitialized home.
    expect(await runCli(['list'], env)).toBe(1);
    expect(err()).toContain('CLI_NOT_INITIALIZED');
    expect(err()).toContain('memory');
  });
});

describe('medha write plane', () => {
  test('record --ensure creates the entity; without it nothing is written', async () => {
    const { env, out } = fresh();
    await runCli(['init'], env);

    expect(await runCli(['record', '--id', 'ghost', '--signal', 'APPLY', '--json'], env)).toBe(0);
    expect(JSON.parse(out().slice(out().indexOf('{'))).recorded).toBe(false);

    expect(await runCli(['record', '--id', 'r1', '--signal', 'APPLY', '--ensure'], env)).toBe(0);
    expect(await runCli(['show', '--id', 'r1', '--json'], env)).toBe(0);
    expect(out()).toContain('"known": true');
  });

  test('guard needs exactly one of --ok / --fail', async () => {
    const { env, err } = fresh();
    await runCli(['init'], env);
    await runCli(['record', '--id', 'r1', '--signal', 'APPLY', '--ensure'], env);
    expect(await runCli(['guard', '--id', 'r1'], env)).toBe(2);
    expect(await runCli(['guard', '--id', 'r1', '--ok', '--guard', 'review'], env)).toBe(0);
    expect(err()).toContain('--ok/--fail');
  });

  test('propose enters the entity on probation and requires --source', async () => {
    const { env, out } = fresh();
    await runCli(['init'], env);
    expect(await runCli(['propose', '--id', 'p1'], env)).toBe(2);
    expect(
      await runCli(
        ['propose', '--id', 'p1', '--source', 'test', '--evidence', 'a, b', '--json'],
        env,
      ),
    ).toBe(0);
    expect(JSON.parse(out().slice(out().indexOf('{'))).hint.status).toBe('probation');
  });

  test('record with --author and --at records author provenance and backfills timestamp', async () => {
    const { env, out } = fresh();
    await runCli(['init'], env);
    const historicalTime = '2025-01-01T00:00:00Z';
    expect(
      await runCli(
        [
          'record',
          '--id',
          'hist1',
          '--signal',
          'APPLY',
          '--ensure',
          '--author',
          'alice',
          '--at',
          historicalTime,
          '--json',
        ],
        env,
      ),
    ).toBe(0);

    const beforeShow = out();
    expect(await runCli(['show', '--id', 'hist1', '--json'], env)).toBe(0);
    const shown = JSON.parse(out().slice(beforeShow.length)) as {
      detail: { recentEpisodes: { author?: string; at: number }[] };
    };
    const episode = shown.detail.recentEpisodes[0];
    expect(episode).toBeDefined();
    expect(episode?.author).toBe('alice');
    expect(episode?.at).toBe(Date.parse(historicalTime));
  });

  test('record, guard, and propose with --note attach rationale and display on show', async () => {
    const { env, out } = fresh();
    await runCli(['init'], env);

    // 1. Record with --note
    const beforeRecord = out();
    expect(
      await runCli(
        [
          'record',
          '--id',
          'noted1',
          '--signal',
          'APPLY',
          '--ensure',
          '--note',
          'Fixed edge case with null bytes',
        ],
        env,
      ),
    ).toBe(0);
    const recordOut = out().slice(beforeRecord.length);
    expect(recordOut).toContain('note:     Fixed edge case with null bytes');

    // 2. Show verifies lastNote and episode note
    const beforeShow1 = out();
    expect(await runCli(['show', '--id', 'noted1'], env)).toBe(0);
    const show1Out = out().slice(beforeShow1.length);
    expect(show1Out).toContain('last note: Fixed edge case with null bytes');
    expect(show1Out).toContain('Fixed edge case with null bytes');

    // 3. Guard with --note updates lastNote
    const beforeGuard = out();
    expect(
      await runCli(
        ['guard', '--id', 'noted1', '--ok', '--guard', 'review', '--note', 'Passed linter checks'],
        env,
      ),
    ).toBe(0);
    const guardOut = out().slice(beforeGuard.length);
    expect(guardOut).toContain('note:     Passed linter checks');

    const beforeShow2 = out();
    expect(await runCli(['show', '--id', 'noted1', '--json'], env)).toBe(0);
    const show2 = JSON.parse(out().slice(beforeShow2.length)) as {
      detail: { hint: { lastNote?: string }; recentEpisodes: { note?: string }[] };
    };
    expect(show2.detail.hint.lastNote).toBe('Passed linter checks');
    expect(show2.detail.recentEpisodes[0]?.note).toBe('Passed linter checks');
  });

  test('retract command appends a retract episode and masks the target', async () => {
    const { env, out } = fresh();
    await runCli(['init'], env);
    await runCli(['record', '--id', 'r1', '--signal', 'APPLY', '--ensure'], env);
    const beforeRetract = out();
    expect(
      await runCli(
        ['retract', '--seq', '0', '--reason', 'mistake', '--author', 'bob', '--json'],
        env,
      ),
    ).toBe(0);
    const retractReport = JSON.parse(out().slice(beforeRetract.length)) as {
      targetSeq: number;
      reason: string;
      episode: { type: string; author?: string };
    };
    expect(retractReport.targetSeq).toBe(0);
    expect(retractReport.reason).toBe('mistake');
    expect(retractReport.episode.type).toBe('retract');
    expect(retractReport.episode.author).toBe('bob');
  });

  test('remove-episode physically removes episode from log and resequences', async () => {
    const { env, out } = fresh();
    await runCli(['init'], env);
    await runCli(['record', '--id', 'r1', '--signal', 'APPLY', '--ensure'], env);
    await runCli(['record', '--id', 'r2', '--signal', 'APPLY', '--ensure'], env);

    const beforeRemove = out();
    expect(await runCli(['remove-episode', '--seq', '0', '--json'], env)).toBe(0);
    const removeReport = JSON.parse(out().slice(beforeRemove.length)) as {
      removed: boolean;
      remainingCount: number;
    };
    expect(removeReport.removed).toBe(true);
    expect(removeReport.remainingCount).toBe(1);
  });
});

describe('medha pack command', () => {
  test('packs rules into token budget with markdown format', async () => {
    const { env, out } = fresh();
    await runCli(['init'], env);
    await seedHome(env);

    const beforePack = out();
    expect(await runCli(['pack', '--budget', '200'], env)).toBe(0);
    const text = out().slice(beforePack.length);
    expect(text).toContain('# Medha Evidential Context');
    expect(text).toContain('selected');
    expect(text).toContain('tokens');
  });

  test('pack with --format compact outputs tabular format', async () => {
    const { env, out } = fresh();
    await runCli(['init'], env);
    await seedHome(env);

    const beforePack = out();
    expect(await runCli(['pack', '--budget', '200', '--format', 'compact'], env)).toBe(0);
    const text = out().slice(beforePack.length);
    expect(text).toContain('medha: packed');
    expect(text).toContain('TRUST  STATUS');
  });

  test('pack --json outputs structured report', async () => {
    const { env, out } = fresh();
    await runCli(['init'], env);
    await seedHome(env);

    const beforePack = out();
    expect(await runCli(['pack', '--budget', '500', '--json'], env)).toBe(0);
    const report = JSON.parse(out().slice(beforePack.length)) as {
      budget: number;
      outcome: { selected: unknown[]; totalCost: number; utilization: number };
    };
    expect(report.budget).toBe(500);
    expect(report.outcome.selected.length).toBeGreaterThan(0);
    expect(report.outcome.totalCost).toBeLessThanOrEqual(500);
  });

  test('missing --budget fails with usage error', async () => {
    const { env, err } = fresh();
    await runCli(['init'], env);
    expect(await runCli(['pack'], env)).toBe(2);
    expect(err()).toContain('--budget');
  });
});

describe('medha maintain plane', () => {
  test('maintain preflight on healthy store reports ok (exit 0)', async () => {
    const { env, out } = fresh();
    await runCli(['init'], env);
    await seedHome(env);

    expect(await runCli(['maintain', 'preflight'], env)).toBe(0);
    const text = out();
    expect(text).toContain('preflight for');
    expect(text).toContain('status:     ok');
    expect(text).toContain('integrity:  ok');
  });

  test('maintain preflight --json outputs structured report (exit 0)', async () => {
    const { env, out } = fresh();
    await runCli(['init'], env);
    await seedHome(env);

    const before = out();
    expect(await runCli(['maintain', 'preflight', '--json'], env)).toBe(0);
    const report = JSON.parse(out().slice(before.length)) as {
      preflight: { status: string; episodeCount: number };
    };
    expect(report.preflight.status).toBe('ok');
    expect(report.preflight.episodeCount).toBeGreaterThan(0);
  });

  test('maintain preflight on a corrupt store exits 1 and reports without throwing', async () => {
    const { env, out, home } = fresh();
    // Use file backend so we can hand-corrupt the JSONL state
    expect(await runCli(['init', '--store', 'file'], env)).toBe(0);
    await seedHome(env);

    // Corrupt the state.jsonl file
    const stateFile = join(home, 'state.jsonl');
    writeFileSync(stateFile, '{corrupted-json-line\n');

    const before = out();
    expect(await runCli(['maintain', 'preflight'], env)).toBe(1);
    const text = out().slice(before.length);
    expect(text).toContain('corrupt');
    expect(text).toContain('preflight exits 1');

    // --json also exits 1 and reports without throwing
    const beforeJson = out();
    expect(await runCli(['maintain', 'preflight', '--json'], env)).toBe(1);
    const report = JSON.parse(out().slice(beforeJson.length)) as {
      preflight: { status: string };
    };
    expect(report.preflight.status).toBe('corrupt');
  });

  test('maintain compact folds history and names the folded range', async () => {
    const { env, out, setNow } = fresh();
    await runCli(['init'], env);
    await seedHome(env);

    // Advance clock by 100 days so existing episodes fall outside the 30-day window
    const futureTime = NOW + 100 * 24 * 60 * 60 * 1000;
    setNow(futureTime);

    expect(await runCli(['maintain', 'compact', '--older-than', '30'], env)).toBe(0);
    const text = out();
    expect(text).toContain('compaction for');
    expect(text).toContain('folded range:');
    expect(text).toContain('0..');
    expect(text).toContain('baselines written:');

    // Also test --json output
    const beforeJson = out();
    expect(await runCli(['maintain', 'compact', '--json'], env)).toBe(0);
    const report = JSON.parse(out().slice(beforeJson.length)) as {
      report: { remainingEpisodes: number; compacted: { from: number; to: number } | null };
    };
    expect(report.report).toBeDefined();
    expect(report.report.compacted).toBeDefined();

    // Invalid --older-than (0 or non-integer) is usage (exit 2)
    expect(await runCli(['maintain', 'compact', '--older-than', '0'], env)).toBe(2);
  });

  test('maintain backup and restore round-trips a store', async () => {
    const { env, root, out } = fresh();
    await runCli(['init'], env);
    await seedHome(env);

    // Verify initial entity count
    const beforeList = out();
    await runCli(['list', '--json'], env);
    const initialList = JSON.parse(out().slice(beforeList.length)) as {
      page: { items: unknown[] };
    };
    expect(initialList.page.items.length).toBeGreaterThan(0);

    // Backup to snapshot file
    const backupPath = join(root, 'backup.json');
    expect(await runCli(['maintain', 'backup', backupPath], env)).toBe(0);
    expect(existsSync(backupPath)).toBe(true);

    // Wipe store with recreate
    expect(await runCli(['init', '--recreate'], env)).toBe(0);
    const afterWipeList = out();
    await runCli(['list', '--json'], env);
    const wipedList = JSON.parse(out().slice(afterWipeList.length)) as {
      page: { items: unknown[] };
    };
    expect(wipedList.page.items.length).toBe(0);

    // Restore from backup
    expect(await runCli(['maintain', 'restore', backupPath], env)).toBe(0);

    // Verify entities are restored
    const afterRestoreList = out();
    await runCli(['list', '--json'], env);
    const restoredList = JSON.parse(out().slice(afterRestoreList.length)) as {
      page: { items: unknown[] };
    };
    expect(restoredList.page.items.length).toBe(initialList.page.items.length);
  });

  test('maintain restore on invalid snapshot file fails with CLI_SNAPSHOT_INVALID (exit 1)', async () => {
    const { env, root, err } = fresh();
    await runCli(['init'], env);

    const bogusPath = join(root, 'bogus.json');
    writeFileSync(bogusPath, JSON.stringify({ not: 'a snapshot' }), 'utf8');

    expect(await runCli(['maintain', 'restore', bogusPath], env)).toBe(1);
    expect(err()).toContain('CLI_SNAPSHOT_INVALID');
  });
});

describe('medha updater plane', () => {
  test('updater list lists all built-in updaters', async () => {
    const { env, out } = fresh();
    await runCli(['init'], env);

    expect(await runCli(['updater', 'list'], env)).toBe(0);
    const text = out();
    expect(text).toContain('updaters');
    expect(text).toContain('ema');
    expect(text).toContain('[builtin]');
    expect(text).toContain('wilson');
    expect(text).toContain('asymmetric-penalty');
  });

  test('updater list --json outputs JSON list of updaters', async () => {
    const { env, out } = fresh();
    await runCli(['init'], env);

    const before = out();
    expect(await runCli(['updater', 'list', '--json'], env)).toBe(0);
    const report = JSON.parse(out().slice(before.length)) as {
      updaters: { name: string; source: string }[];
    };
    expect(Array.isArray(report.updaters)).toBe(true);
    const ema = report.updaters.find((u) => u.name === 'ema');
    expect(ema).toBeDefined();
    expect(ema?.source).toBe('builtin');
  });

  test('updater show displays updater details', async () => {
    const { env, out } = fresh();
    await runCli(['init'], env);

    expect(await runCli(['updater', 'show', 'ema'], env)).toBe(0);
    const text = out();
    expect(text).toContain('updater:     ema');
    expect(text).toContain('source:      builtin');
    expect(text).toContain('description: Exponential Moving Average');

    // Also test --json
    const beforeJson = out();
    expect(await runCli(['updater', 'show', 'wilson', '--json'], env)).toBe(0);
    const report = JSON.parse(out().slice(beforeJson.length)) as {
      name: string;
      source: string;
      description: string;
    };
    expect(report.name).toBe('wilson');
    expect(report.source).toBe('builtin');
  });

  test('updater show on unknown updater fails with CLI_UPDATER_UNKNOWN (exit 1)', async () => {
    const { env, err } = fresh();
    await runCli(['init'], env);

    expect(await runCli(['updater', 'show', 'nonexistent'], env)).toBe(1);
    expect(err()).toContain('CLI_UPDATER_UNKNOWN');
    expect(err()).toContain('known updaters');
    expect(err()).toContain('ema');
  });

  test('updater fork scaffolds custom template and guards against overwriting', async () => {
    const { env, root, out, err } = fresh();
    await runCli(['init'], env);

    // Fork default path
    expect(await runCli(['updater', 'fork', 'ema'], env)).toBe(0);
    const text = out();
    expect(text).toContain('scaffolded custom updater from');
    expect(text).toContain('ema');

    const defaultForkPath = join(root, '.medha', 'updaters', 'ema-fork.ts');
    expect(existsSync(defaultForkPath)).toBe(true);
    const scaffoldContent = readFileSync(defaultForkPath, 'utf8');
    expect(scaffoldContent).toContain('export const emaCustomUpdater');
    expect(scaffoldContent).toContain('UpdaterRegistry');

    // Fork to explicit path
    const customOut = join(root, 'custom-updater.ts');
    expect(await runCli(['updater', 'fork', 'wilson', '--out', customOut], env)).toBe(0);
    expect(existsSync(customOut)).toBe(true);

    // Overwriting without moving/removing fails with CLI_FORK_EXISTS
    expect(await runCli(['updater', 'fork', 'wilson', '--out', customOut], env)).toBe(1);
    expect(err()).toContain('CLI_FORK_EXISTS');
  });

  test('updater fork on unknown updater fails with CLI_UPDATER_UNKNOWN (exit 1)', async () => {
    const { env, err } = fresh();
    await runCli(['init'], env);

    expect(await runCli(['updater', 'fork', 'nonexistent'], env)).toBe(1);
    expect(err()).toContain('CLI_UPDATER_UNKNOWN');
  });
});

describe('medha mcp server', () => {
  async function connect(root: string) {
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    let err = '';
    const env: Environment = {
      cwd: root,
      env: {},
      now: () => NOW,
      isTTY: false,
      exitCode: 0,
      stdout: () => undefined,
      stderr: (text) => {
        err += text;
      },
    };
    const served = serveMcp({ dir: root }, env, serverSide);
    const client = new Client({ name: 'test-mcp-client', version: '1.0.0' });
    await client.connect(clientSide);
    return {
      client,
      stderr: () => err,
      close: async () => {
        await client.close();
        await served;
      },
    };
  }

  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text: string }[])[0]?.text ?? '';
    return { isError: result.isError === true, body: JSON.parse(text) };
  };

  test('lists all twelve tools and calls every tool with asserted results', async () => {
    const { env, root } = fresh();
    await runCli(['init'], env);
    await seedHome(env);

    const session = await connect(root);
    try {
      const { client } = session;
      const tools = (await client.listTools()).tools.map((t) => t.name);
      expect(tools).toHaveLength(12);
      expect(tools).toEqual(
        expect.arrayContaining([
          'hints',
          'list_entities',
          'show_entity',
          'record_signal',
          'report_guard',
          'propose',
          'drift',
          'simulate',
          'status',
          'retract_episode',
          'remove_episode',
          'pack_context',
        ]),
      );

      // 1. hints (batch)
      const hintsRes = await call(client, 'hints', {
        keys: [{ id: 't1' }, { id: 'a1' }],
      });
      expect(hintsRes.isError).toBe(false);
      const values = hintsRes.body.hints as { key: { id: string }; status: string }[];
      expect(values).toHaveLength(2);
      expect(hintsRes.body.unknown).toEqual([]);

      // unknown keys are reported, not silently dropped; compact shrinks the hint
      const mixed = await call(client, 'hints', {
        keys: [{ id: 't1' }, { id: 'nope' }],
        compact: true,
      });
      expect(mixed.body.unknown).toEqual([{ namespace: '', kind: 'rule', id: 'nope' }]);
      expect(mixed.body.hints).toHaveLength(1);
      expect(mixed.body.hints[0].key).toBe('rule/t1');
      expect(values.some((h) => h.key.id === 't1')).toBe(true);
      expect(values.some((h) => h.key.id === 'a1')).toBe(true);

      // 2. list_entities
      const listRes = await call(client, 'list_entities', { limit: 10 });
      expect(listRes.isError).toBe(false);
      expect(listRes.body.items.length).toBeGreaterThan(0);

      // 3. show_entity
      const showRes = await call(client, 'show_entity', { id: 't1' });
      expect(showRes.isError).toBe(false);
      expect(showRes.body.hint.key.id).toBe('t1');
      expect(showRes.body.known).toBe(true);

      // 4. record_signal
      const recRes = await call(client, 'record_signal', {
        id: 'mcp_test_e',
        signal: 'APPLY',
        ensure: true,
      });
      expect(recRes.isError).toBe(false);
      expect(recRes.body.hint.key.id).toBe('mcp_test_e');
      expect(recRes.body.recorded).toBe(true);

      // an unknown entity without ensure is flagged, not silently accepted
      const ghost = await call(client, 'record_signal', { id: 'ghost', signal: 'APPLY' });
      expect(ghost.body.recorded).toBe(false);
      expect(ghost.body.note).toContain('ensure');

      // 5. report_guard
      const guardRes = await call(client, 'report_guard', {
        id: 'mcp_test_e',
        ok: true,
        guardKind: 'harness',
      });
      expect(guardRes.isError).toBe(false);
      expect(guardRes.body.key.id).toBe('mcp_test_e');

      // 6. propose
      const propRes = await call(client, 'propose', {
        id: 'mcp_prop_e',
        source: 'test-miner',
        text: 'test proposal text',
      });
      expect(propRes.isError).toBe(false);
      expect(propRes.body.promoted).toBeDefined();
      expect(propRes.body.trustScore).toBeUndefined(); // no duplicated flat hint
      expect(propRes.body.state).toBeUndefined();
      expect(propRes.body.episode).toBeDefined();

      // 7. drift
      const driftRes = await call(client, 'drift', { limit: 5 });
      expect(driftRes.isError).toBe(false);
      expect(Array.isArray(driftRes.body.drifting)).toBe(true);
      expect(typeof driftRes.body.count).toBe('number');

      // 8. simulate
      const simRes = await call(client, 'simulate', { id: 't1', signal: 'APPLY' });
      expect(simRes.isError).toBe(false);
      expect(simRes.body.before).toBeDefined();
      expect(simRes.body.after).toBeDefined();

      // Error handling: simulate invalid signal
      const badSim = await call(client, 'simulate', { id: 't1', signal: 'NON_EXISTENT' });
      expect(badSim.isError).toBe(true);
      expect(badSim.body.error.code).toBe('CORE_UNKNOWN_REGISTRY_ENTRY');

      // 9. status
      const statusRes = await call(client, 'status', {});
      expect(statusRes.isError).toBe(false);
      expect(statusRes.body.preflight.status).toBe('ok');
      expect(statusRes.body.byStatus).toBeDefined();

      // 10. retract_episode
      const retractRes = await call(client, 'retract_episode', {
        seq: 0,
        reason: 'mcp test retraction',
        author: 'mcp-agent',
      });
      expect(retractRes.isError).toBe(false);
      expect(retractRes.body.retractedSeq).toBe(0);

      // 11. remove_episode
      const removeRes = await call(client, 'remove_episode', { seq: 0 });
      expect(removeRes.isError).toBe(false);
      expect(removeRes.body.removed).toBe(true);

      // 12. pack_context
      const packRes = await call(client, 'pack_context', { budget: 500 });
      expect(packRes.isError).toBe(false);
      expect(packRes.body.totalCost).toBeDefined();
      expect(packRes.body.contextText).toBeDefined();
    } finally {
      await session.close();
    }
    expect(session.stderr()).toContain('medha mcp: serving');
  });

  test('subprocess stdio handshake: initialize -> tools/list -> clean exit on stdin close', async () => {
    const { env, root } = fresh();
    await runCli(['init'], env);

    const bin = join(import.meta.dir, 'bin.ts');
    const proc = spawn(process.execPath, [bin, 'mcp', '--dir', root], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buf = '';
    let sawInit = false;
    let sawTools = false;

    const exitPromise = new Promise<number>((resolve) => {
      proc.on('exit', (code) => resolve(code ?? 0));
    });

    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as { id?: number; result?: { tools?: unknown[] } };
        if (msg.id === 1) {
          sawInit = true;
          proc.stdin.write(
            `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
          );
          proc.stdin.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`,
          );
        } else if (msg.id === 2) {
          sawTools = true;
          expect(msg.result?.tools).toHaveLength(12);
          proc.stdin.end();
        }
      }
    });

    // Send initialize request
    const initReq = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    };
    proc.stdin.write(`${JSON.stringify(initReq)}\n`);

    const exitCode = await exitPromise;
    expect(sawInit).toBe(true);
    expect(sawTools).toBe(true);
    expect(exitCode).toBe(0);
  });
});

describe('medha sync commands', () => {
  test('sync status reports uninitialized when sync target does not exist', async () => {
    const { env, out } = fresh();
    await runCli(['init'], env);

    const syncFile = join(env.cwd, 'sync.json');
    expect(await runCli(['sync', 'status', '--file', syncFile], env)).toBe(0);
    expect(out()).toContain('Sync Status: UNINITIALIZED');
  });

  test('sync push and pull round-trip through a file', async () => {
    const { env, out } = fresh();
    await runCli(['init'], env);
    await seedHome(env);

    const syncFile = join(env.cwd, 'sync.json');
    // Push
    expect(await runCli(['sync', 'push', '--file', syncFile], env)).toBe(0);
    expect(out()).toContain('Sync push completed successfully');
    expect(out()).toContain('Pushed entities: 5');

    // Status is synced
    expect(await runCli(['sync', 'status', '--file', syncFile], env)).toBe(0);
    expect(out()).toContain('Sync Status: SYNCED');

    // Pull with --json
    expect(await runCli(['sync', 'pull', '--file', syncFile, '--json'], env)).toBe(0);
    expect(out()).toContain('"ok": true');
  });
});
