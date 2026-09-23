import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sage, type SageSnapshot } from '@sutras/sage';
import { MemoryStore } from '@sutras/sage-store';
import { runCli } from './cli.ts';
import type { Environment } from './environment.ts';
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
} {
  const root = join(tmpdir(), `sage-cli-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  cleanups = [...cleanups, root];
  let out = '';
  let err = '';
  const env: Environment = {
    cwd: root,
    env: {},
    now: () => NOW,
    isTTY: false,
    exitCode: 0,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
  };
  return { env, root, home: join(root, '.sutra', 'sage'), out: () => out, err: () => err };
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
