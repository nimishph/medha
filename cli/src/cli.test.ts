import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sage, type SageSnapshot } from '@sutras/sage';
import type { EntityKey } from '@sutras/sage-core';
import { MemoryStore } from '@sutras/sage-store';
import { runCli } from './cli.ts';
import type { Environment } from './environment.ts';
import { type SageConfigV1, storeForConfig } from './layout.ts';
import { VERSION } from './version.ts';

/**
 * `sage init` acceptance (Loom-ujs3.11.2). Each test gets a throwaway project root; the harness
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
    home: join(root, '.sutra', 'sage'),
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
    expect(out()).toBe(`sage ${VERSION}\n`);
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
});

describe('sage init — default sqlite backend', () => {
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
    expect(report.home).toBe(join(root, '.sutra', 'sage'));
    expect(report.backend).toBe('sqlite');
    expect(report.preflight.status).toBe('ok');
  });
});

describe('sage init — backends and paths', () => {
  test('file backend writes the state.jsonl document file', async () => {
    const { env, home } = fresh();
    expect(await runCli(['init', '--store', 'file'], env)).toBe(0);
    expect(existsSync(join(home, 'state.jsonl'))).toBe(true);
    expect(readConfig(home).path).toBe(join(home, 'state.jsonl'));
    // .bak exists only after a second atomic write; a fresh init has exactly the main doc.
    expect(existsSync(join(home, 'state.jsonl.bak'))).toBe(false);
  });

  test('memory backend persists nothing', async () => {
    const { env, root, out } = fresh();
    expect(await runCli(['init', '--store', 'memory'], env)).toBe(0);
    expect(existsSync(join(root, '.sutra'))).toBe(false);
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

describe('sage init — idempotency', () => {
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

describe('sage init — registry validation', () => {
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

describe('sage init — beyond the happy path', () => {
  test('--backup writes a SageSnapshot that restores in-process', async () => {
    const { env, root } = fresh();
    const backup = join(root, 'backup.json');
    expect(await runCli(['init', '--backup', backup], env)).toBe(0);

    const parsed = JSON.parse(readFileSync(backup, 'utf8')) as unknown as {
      snapshot: SageSnapshot;
    };
    expect(parsed.snapshot.format).toBe('sutras.sage/v1');
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
  const config = readConfig(join(env.cwd, '.sutra', 'sage')) as unknown as SageConfigV1;
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

describe('sage maintain plane', () => {
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

describe('sage updater plane', () => {
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

    const defaultForkPath = join(root, '.sutra', 'sage', 'updaters', 'ema-fork.ts');
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
