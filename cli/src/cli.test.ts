import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Medha, type MedhaSnapshot, Sage } from '@cntxt-labs/medha';
import { type EntityKey, InvalidArgumentError } from '@cntxt-labs/medha-core';
import { MemoryStore } from '@cntxt-labs/medha-store';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { runCli } from './cli.ts';
import type { Environment } from './environment.ts';
import { type MedhaConfigV1, readConfig as readConfigOrNull, storeForConfig } from './layout.ts';
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
  const root = join(tmpdir(), `medha-cli-${process.pid}-${Math.random().toString(36).slice(2)}`);
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

/** Raw config.json bytes as written to disk — for asserting the on-disk representation itself
 * (e.g. that a path was stored relative to `home`), as opposed to `readConfig`'s resolved view. */
function readRawConfig(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as Record<string, unknown>;
}

/**
 * `stdout` accumulates across every command in a test, so a multi-command test needs to slice out
 * just the one it is asserting on. `markOut` before the call, `outSince` after.
 */
function markOut(out: () => string): number {
  return out().length;
}

function outSince(out: () => string, mark: number): string {
  return out().slice(mark);
}

/** `layout.ts`'s `readConfig`, asserting the home is already initialized (every caller here just ran `init`). */
function readConfig(home: string): MedhaConfigV1 {
  const config = readConfigOrNull(home);
  if (config === null) {
    throw new InvalidArgumentError('home', 'an initialized home', home);
  }
  return config;
}

describe('medha entrypoint', () => {
  test('--version prints the manifest version and exits 0', async () => {
    const { env, out } = fresh();
    expect(await runCli(['--version'], env)).toBe(0);
    expect(out()).toBe(`medha ${VERSION}\n`);
  });

  test('bare medha prints usage to stderr and exits 2', async () => {
    const { env, err } = fresh();
    expect(await runCli([], env)).toBe(2);
    expect(err()).toContain('init');
  });

  test('medha help prints usage to stdout and exits 0', async () => {
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

describe('medha init — .gitignore and README scaffolding', () => {
  test('sqlite: gitignores the store + WAL/SHM, keeps config.json trackable', async () => {
    const { env, home, out } = fresh();
    expect(await runCli(['init'], env)).toBe(0);

    const gitignorePath = join(home, '.gitignore');
    expect(existsSync(gitignorePath)).toBe(true);
    const gitignore = readFileSync(gitignorePath, 'utf8');
    const patterns = gitignore.split('\n').filter((line) => line !== '' && !line.startsWith('#'));
    expect(patterns).not.toContain('config.json');
    expect(gitignore).toContain('store.sqlite\n');
    expect(gitignore).toContain('store.sqlite-wal');
    expect(gitignore).toContain('store.sqlite-shm');

    const readmePath = join(home, 'README.md');
    expect(existsSync(readmePath)).toBe(true);
    expect(readFileSync(readmePath, 'utf8')).toContain('config.json');

    expect(out()).toContain(`gitignore:  ${gitignorePath}`);
    expect(out()).toContain(`readme:     ${readmePath}`);
  });

  test('file backend: gitignores the document + backup/temp, not config.json', async () => {
    const { env, home } = fresh();
    expect(await runCli(['init', '--store', 'file'], env)).toBe(0);
    const gitignore = readFileSync(join(home, '.gitignore'), 'utf8');
    const patterns = gitignore.split('\n').filter((line) => line !== '' && !line.startsWith('#'));
    expect(patterns).not.toContain('config.json');
    expect(gitignore).toContain('state.jsonl\n');
    expect(gitignore).toContain('state.jsonl.bak');
    expect(gitignore).toContain('state.jsonl.tmp');
  });

  test('the memory backend has no home directory, so nothing is scaffolded', async () => {
    const { env, out } = fresh();
    expect(await runCli(['init', '--store', 'memory'], env)).toBe(0);
    expect(out()).not.toContain('gitignore:');
    expect(out()).not.toContain('readme:');
  });

  test('--recreate rewrites both files rather than leaving stale ones', async () => {
    const { env, home } = fresh();
    await runCli(['init'], env);
    writeFileSync(join(home, '.gitignore'), 'stale\n', 'utf8');
    expect(await runCli(['init', '--recreate'], env)).toBe(0);
    expect(readFileSync(join(home, '.gitignore'), 'utf8')).not.toBe('stale\n');
  });
});

describe('medha init — backends and paths', () => {
  test('file backend writes the state.jsonl document file', async () => {
    const { env, home } = fresh();
    expect(await runCli(['init', '--store', 'file'], env)).toBe(0);
    expect(existsSync(join(home, 'state.jsonl'))).toBe(true);
    expect(readConfig(home).path).toBe(join(home, 'state.jsonl'));
    expect(readRawConfig(home).path).toBe('state.jsonl');
    // .bak exists only after a second atomic write; a fresh init has exactly the main doc.
    expect(existsSync(join(home, 'state.jsonl.bak'))).toBe(false);
  });

  test('config.json is portable: a home copied to a new absolute location still opens', async () => {
    const { env, root } = fresh();
    expect(await runCli(['init'], env)).toBe(0);
    await new Medha({ store: storeForConfig(readConfig(join(root, '.medha'))) }).record(
      { namespace: '', kind: 'rule', id: 'portable' },
      'APPLY',
      { now: NOW },
      { ensure: true },
    );

    const moved = join(
      root,
      '..',
      `${basename(root)}-moved-${Math.random().toString(36).slice(2)}`,
    );
    cpSync(root, moved, { recursive: true });
    cleanups = [...cleanups, moved];

    const movedEnv: Environment = { ...env, cwd: moved };
    expect(await runCli(['status'], movedEnv)).toBe(0);
    expect(await runCli(['show', '--id', 'portable'], movedEnv)).toBe(0);

    const movedConfig = readConfig(join(moved, '.medha'));
    expect(movedConfig.path).toBe(join(moved, '.medha', 'store.sqlite'));
    expect(existsSync(movedConfig.path as string)).toBe(true);
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
  test('a second init refreshes without touching the store', async () => {
    const { env, home, out } = fresh();
    await runCli(['init'], env);
    await runCli(['record', '--id', 'r1', '--signal', 'APPLY', '--ensure'], env);
    const config = readFileSync(join(home, 'config.json'), 'utf8');
    expect(await runCli(['init'], env)).toBe(0);
    expect(out()).toContain('already initialized; store left as it is');
    expect(readFileSync(join(home, 'config.json'), 'utf8')).toBe(config);
    expect(await runCli(['show', '--id', 'r1', '--json'], env)).toBe(0);
    expect(out()).toContain('"r1"');
  });

  test('a matching --config refreshes as well', async () => {
    const { env, root } = fresh();
    await runCli(['init'], env);
    const cfg = join(root, 'empty.json');
    writeFileSync(cfg, '{}');
    expect(await runCli(['init', '--config', cfg], env)).toBe(0);
  });

  test('a scope change on an initialized home asks for --recreate', async () => {
    const { env, err } = fresh();
    await runCli(['init'], env);
    expect(await runCli(['init', '--namespace', 'a'], env)).not.toBe(0);
    expect(err()).toContain('--recreate');
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

    const registries = readRawConfig(home).registries as { kinds: string[] };
    expect(registries.kinds).toContain('gadget');
    expect(registries.kinds).not.toContain('widget');
  });
});

describe('medha init — agent instruction section', () => {
  const section = /<!-- medha:begin v[^\n]*-->[\s\S]*<!-- medha:end -->/;

  test('creates AGENTS.md with the section when no instruction file exists', async () => {
    const { env, root, out } = fresh();
    expect(await runCli(['init'], env)).toBe(0);
    const text = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    expect(text).toMatch(section);
    expect(text).toContain(`medha:begin v${VERSION}`);
    expect(text).toContain('medha show --id');
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
    expect(out()).toContain('created AGENTS.md');
  });

  test('appends to existing AGENTS.md and CLAUDE.md, keeping what is there', async () => {
    const { env, root } = fresh();
    writeFileSync(join(root, 'AGENTS.md'), '# Agents\n\nBe kind.\n');
    writeFileSync(join(root, 'CLAUDE.md'), '# Claude\n');
    expect(await runCli(['init'], env)).toBe(0);
    const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    expect(agents.startsWith('# Agents\n\nBe kind.\n\n<!-- medha:begin')).toBe(true);
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toMatch(section);
  });

  test('skips a CLAUDE.md that only imports AGENTS.md', async () => {
    const { env, root } = fresh();
    writeFileSync(join(root, 'AGENTS.md'), '# Agents\n');
    writeFileSync(join(root, 'CLAUDE.md'), '@AGENTS.md\n');
    expect(await runCli(['init'], env)).toBe(0);
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n');
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toMatch(section);
  });

  test('a re-run replaces an older section in place and leaves the rest alone', async () => {
    const { env, root, out } = fresh();
    writeFileSync(
      join(root, 'AGENTS.md'),
      '# Top\n\n<!-- medha:begin v0.1.0 — old -->\nstale advice\n<!-- medha:end -->\n\n## Bottom\n',
    );
    expect(await runCli(['init'], env)).toBe(0);
    const text = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    expect(text).not.toContain('stale advice');
    expect(text.startsWith('# Top\n\n<!-- medha:begin')).toBe(true);
    expect(text.endsWith('<!-- medha:end -->\n\n## Bottom\n')).toBe(true);
    expect(out()).toContain('was v0.1.0');

    expect(await runCli(['init'], env)).toBe(0);
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(text);
    expect(out()).toContain('section is current');
  });

  test('--agents-file names the file; --no-agents-file writes none', async () => {
    const named = fresh();
    expect(await runCli(['init', '--agents-file', 'docs/agents.md'], named.env)).toBe(0);
    expect(readFileSync(join(named.root, 'docs', 'agents.md'), 'utf8')).toMatch(section);
    expect(existsSync(join(named.root, 'AGENTS.md'))).toBe(false);

    const none = fresh();
    expect(await runCli(['init', '--no-agents-file', '--json'], none.env)).toBe(0);
    expect(existsSync(join(none.root, 'AGENTS.md'))).toBe(false);
    expect(JSON.parse(none.out()).agentFiles).toEqual([]);
  });

  test('the memory backend writes no section', async () => {
    const { env, root } = fresh();
    expect(await runCli(['init', '--store', 'memory'], env)).toBe(0);
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
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

  /*
   * An unrecognised config key used to be accepted and dropped, so a policy the operator believed
   * was active simply was not. The failure mode was invisible: init exited 0, the home initialised,
   * and the typo only showed up as a rule that never behaved as configured (nimishph/medha#5).
   */
  test('an unknown top-level config key is refused, naming the key and the allowed set', async () => {
    const { env, root, err } = fresh();
    const cfg = join(root, 'typo.json');
    // 'kindPolicies' is a plausible misspelling of 'kindSpecs'.
    writeFileSync(cfg, JSON.stringify({ kindPolicies: { rule: {} } }));

    expect(await runCli(['init', '--config', cfg], env)).toBe(1);
    const message = err();
    expect(message).toContain('kindPolicies');
    // Close enough to be a typo, so it is named back rather than just rejected.
    expect(message).toContain("did you mean 'kindSpecs'?");
    expect(message).toContain('kindSpecs, signalSpecs, anchorKinds');
    expect(message).toContain('CLI_CONFIG_INVALID');

    // And nothing was created: a rejected config must not leave a half-initialised home behind.
    expect(existsSync(join(root, '.medha', 'config.json'))).toBe(false);
  });

  test('an unknown key inside a kindSpec group is refused with its path', async () => {
    const { env, root, err } = fresh();
    const cfg = join(root, 'nested.json');
    writeFileSync(
      cfg,
      JSON.stringify({
        kindSpecs: [
          {
            name: 'rule',
            thresholds: { bogus: 1 },
            recency: { halfLifeDays: 30, florr: 0.3 },
            signalLimits: { minIntervalMs: 100, maxSucessesPerAuthor: 3 },
          },
        ],
      }),
    );

    expect(await runCli(['init', '--config', cfg], env)).toBe(1);
    // The first offender is reported with the group it was found in, so the fix is unambiguous.
    expect(err()).toContain('kindSpecs[0].thresholds');
    expect(err()).toContain('trusted, active, unguardedCeiling');
  });

  test('every allowed kindSpec key is accepted, so strictness does not reject real config', async () => {
    const { env, root } = fresh();
    const cfg = join(root, 'full.json');
    writeFileSync(
      cfg,
      JSON.stringify({
        kindSpecs: [
          {
            name: 'rule',
            description: 'a rule',
            thresholds: {
              trusted: 0.8,
              active: 0.4,
              unguardedCeiling: 0.9,
              retiredTrustThreshold: 0.2,
              minUsesForTrusted: 5,
              minUsesForRetired: 30,
            },
            recency: { halfLifeDays: 30, floor: 0.3 },
            evidenceWeighting: 'count',
            signalLimits: { minIntervalMs: 100, maxSuccessesPerAuthor: 3 },
            decisionPolicy: { requireHumanFor: ['ignore'] },
          },
        ],
      }),
    );

    expect(await runCli(['init', '--config', cfg], env)).toBe(0);
  });

  test('an unknown key is refused in the kinds map and array-of-spec forms too', async () => {
    const { env, root, err } = fresh();

    const asMap = join(root, 'map.json');
    writeFileSync(asMap, JSON.stringify({ kinds: { rule: { thresholds: { nope: 1 } } } }));
    expect(await runCli(['init', '--config', asMap], env)).toBe(1);
    expect(err()).toContain("kinds['rule']");

    const asArray = join(root, 'array.json');
    writeFileSync(
      asArray,
      JSON.stringify({ kinds: [{ name: 'rule', decisionPolicy: { requireHuman: ['ignore'] } }] }),
    );
    expect(await runCli(['init', '--config', asArray], env)).toBe(1);
    expect(err()).toContain('decisionPolicy');
    expect(err()).toContain('requireHumanFor');
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
    const registries = readRawConfig(home).registries as {
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
    const engine = new Medha({ store });
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
// Read plane (Loom-ujs3.11.3): seed a real store through storeForConfig + Medha, then drive every
// read command through the CLI. NOW is fixed, so all rendered timestamps and deltas are golden.
// ---------------------------------------------------------------------------------------------

const SEED_NOW = NOW + 1000;

/** Seed a configured home with known entities and return the store file path. */
async function seedHome(env: Environment): Promise<void> {
  const config = readConfig(join(env.cwd, '.medha'));
  const store = storeForConfig(config);
  const engine = new Medha({ store });
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

describe('medha read plane — list', () => {
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

describe('medha read plane — show', () => {
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

describe('medha read plane — status and drift', () => {
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

/**
 * Drift is a symmetric report but a one-sided quarantine gate (spec section 7). These are the two
 * user-visible consequences, pinned end-to-end: getting either backwards silently buries the best
 * rules in a store (upward) or quietly retires dormant ones (the sweep's age rule).
 */
describe('drift direction (spec section 7: report symmetric, quarantine one-sided)', () => {
  test('sustained success is reported as drifting but is not quarantined', async () => {
    const { env, out } = fresh();
    await runCli(['init'], env);

    // 20 straight APPLYs walk mu to ~0.94, i.e. at least 0.4 *above* the 0.5 default baseline.
    for (let i = 0; i < 20; i++) {
      expect(await runCli(['record', '--id', 'good', '--signal', 'APPLY', '--ensure'], env)).toBe(
        0,
      );
    }

    expect(await runCli(['show', '--id', 'good'], env)).toBe(0);
    const shown = out();
    expect(shown).toContain('drift up yes');
    expect(shown).not.toContain('quarantined');
    expect(shown).toMatch(/trust:\s+0\.[1-9]/);

    // The report still lists it: one-sided applies to the gate, not to observability.
    const beforeDrift = out().length;
    expect(await runCli(['drift'], env)).toBe(0);
    const driftText = out().slice(beforeDrift);
    expect(driftText).toContain('rule/good');
    expect(driftText).toContain('up');
  });

  test('sustained failure is still quarantined', async () => {
    const { env, out } = fresh();
    await runCli(['init'], env);

    for (let i = 0; i < 6; i++) {
      expect(
        await runCli(['record', '--id', 'bad', '--signal', 'REJECT_RULE', '--ensure'], env),
      ).toBe(0);
    }

    expect(await runCli(['show', '--id', 'bad'], env)).toBe(0);
    const shown = out();
    expect(shown).toContain('quarantined');
    expect(shown).toMatch(/trust:\s+0\.000/);
  });

  test('a dormant but unrefuted entity stays on probation: age never retires it', async () => {
    const { env, out, setNow } = fresh();
    await runCli(['init'], env);

    // One success, then silence for well past the recency floor.
    expect(await runCli(['record', '--id', 'old', '--signal', 'APPLY', '--ensure'], env)).toBe(0);
    setNow(NOW + 900 * 24 * 60 * 60 * 1000);

    // Reads are pure, so they never sweep: the kernel alone must not retire on decay.
    expect(await runCli(['show', '--id', 'old'], env)).toBe(0);
    const shown = out();
    expect(shown).toContain('probation');
    expect(shown).not.toContain('retired');
    expect(shown).toMatch(/recency 0\.300/);
    // Decayed, not zeroed.
    expect(shown).toMatch(/trust:\s+0\.0[1-9]/);
  });
});

describe('medha read plane — params, simulate, explain-threshold', () => {
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

describe('medha read plane — home guards', () => {
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

  test('remove-episode --author/--reason land in the audit trail, which backups carry', async () => {
    const { env, root } = fresh();
    await runCli(['init'], env);
    await runCli(['record', '--id', 'r1', '--signal', 'APPLY', '--ensure'], env);
    const args = ['remove-episode', '--seq', '0', '--author', 'human:ops', '--reason', 'bad data'];
    expect(await runCli(args, env)).toBe(0);

    const backupPath = join(root, 'audit.json');
    expect(await runCli(['maintain', 'backup', backupPath], env)).toBe(0);
    const { snapshot } = JSON.parse(readFileSync(backupPath, 'utf8')) as {
      snapshot: { meta: Record<string, string> };
    };
    const trail = JSON.parse(snapshot.meta['audit:removedEpisodes'] ?? '[]') as {
      author: string;
      reason: string;
      episode: { key: { id: string } };
    }[];
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ author: 'human:ops', reason: 'bad data' });
    expect(trail[0]?.episode.key.id).toBe('r1');
  });
});

describe('medha-arj.5: define and decision commands', () => {
  test('define appends a define episode and show renders title/tags/rationale', async () => {
    const { env, out } = fresh();
    await runCli(['init'], env);

    expect(
      await runCli(
        [
          'define',
          '--id',
          'r1',
          '--title',
          'Retry on timeout',
          '--rationale',
          'network calls are flaky in CI',
          '--tags',
          'network,flaky',
        ],
        env,
      ),
    ).toBe(0);
    expect(out()).toContain('medha: defined rule/r1');
    expect(out()).toContain('title:     Retry on timeout');

    const beforeShow = out();
    expect(await runCli(['show', '--id', 'r1'], env)).toBe(0);
    const shown = out().slice(beforeShow.length);
    expect(shown).toContain('definition: Retry on timeout');
    expect(shown).toContain('tags:      network, flaky');
    expect(shown).toContain('rationale: network calls are flaky in CI');
  });

  test('decision creates a root case, a child under --parent, and renders an indented tree', async () => {
    const { env, out } = fresh();
    await runCli(['init'], env);

    const beforeRoot = out();
    expect(
      await runCli(
        ['decision', '--id', 'r1', '--condition', 'touched often', '--probability', '0.5'],
        env,
      ),
    ).toBe(0);
    const rootReport = out().slice(beforeRoot.length);
    const rootId = /decision case (\S+) on/.exec(rootReport)?.[1];
    expect(rootId).toBeDefined();

    expect(
      await runCli(
        [
          'decision',
          '--id',
          'r1',
          '--condition',
          'reviewer approved',
          '--apply',
          '--parent',
          rootId as string,
        ],
        env,
      ),
    ).toBe(0);

    const beforeShow = out();
    expect(await runCli(['show', '--id', 'r1'], env)).toBe(0);
    const shown = out().slice(beforeShow.length);
    expect(shown).toContain('decision tree:');
    expect(shown).toContain(`touched often -> probability(0.5)  [probation]`);
    // The child is indented one level deeper than its parent.
    const rootLine = shown.split('\n').find((l) => l.includes('touched often'));
    const childLine = shown.split('\n').find((l) => l.includes('reviewer approved'));
    expect(rootLine).toBeDefined();
    expect(childLine).toBeDefined();
    expect(childLine?.match(/^\s*/)?.[0].length ?? 0).toBeGreaterThan(
      rootLine?.match(/^\s*/)?.[0].length ?? 0,
    );
  });

  test('decision requires exactly one of --apply/--ignore/--probability', async () => {
    const { env, err } = fresh();
    await runCli(['init'], env);
    expect(await runCli(['decision', '--id', 'r1', '--condition', 'x'], env)).toBe(2);
    expect(err()).toContain('--apply/--ignore/--probability');
  });

  test('decisionPolicy.requireHumanFor rejects an agent-authored apply branch cleanly (exit 1, no stack trace)', async () => {
    const { env, err } = fresh();
    const configPath = join(env.cwd, 'registries.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        kinds: { 'tool-gate': { decisionPolicy: { requireHumanFor: 'apply' } } },
      }),
    );
    await runCli(['init', '--config', configPath], env);

    const rejected = await runCli(
      [
        'decision',
        '--kind',
        'tool-gate',
        '--id',
        't1',
        '--condition',
        'never touched',
        '--apply',
        '--author',
        'agent:reviewer',
      ],
      env,
    );
    expect(rejected).toBe(1);
    // The code stays the machine-readable signal; the hint tells an agent to escalate, not to
    // retry with a `human:` label it can set itself.
    expect(err()).toContain('CORE_PERMISSION_DENIED');
    expect(err()).toContain('hint: Do not retry with another author');
    expect(err()).toContain('Escalate to a human');
    expect(err()).not.toContain("'human:<id>'");
    expect(err()).not.toContain('at ');

    const accepted = await runCli(
      [
        'decision',
        '--kind',
        'tool-gate',
        '--id',
        't1',
        '--condition',
        'never touched',
        '--apply',
        '--author',
        'human:nimish',
      ],
      env,
    );
    expect(accepted).toBe(0);
  });
});

/**
 * Decision trees have to be *buildable* over every public interface, or branch trust is stuck at
 * zero forever: the engine accrues per-branch evidence but nothing could record any, and the tree
 * silently rotted into whatever shape the last partial command left behind. Each test here pins one
 * way a tree used to be corrupted without any error surfacing.
 */
describe('decision trees: branch evidence and structural integrity', () => {
  /** Run `medha decision` and return the minted (or edited) case id from its output. */
  async function decide(
    env: Environment,
    out: () => string,
    args: readonly string[],
  ): Promise<{ caseId: string; text: string }> {
    const before = markOut(out);
    const code = await runCli(['decision', ...args], env);
    expect(code).toBe(0);
    const text = outSince(out, before);
    const caseId = /decision case (\S+) on/.exec(text)?.[1];
    expect(caseId).toBeDefined();
    return { caseId: caseId as string, text };
  }

  test('record --case-id makes the branch learn, not just the rule', async () => {
    const { env, out } = fresh();
    await runCli(['init'], env);
    const { caseId } = await decide(env, out, [
      '--id',
      'r1',
      '--condition',
      'under app/Http/Controllers',
      '--apply',
    ]);

    // Before any evidence the branch reads k=0 n=0.
    const before = markOut(out);
    expect(await runCli(['show', '--id', 'r1'], env)).toBe(0);
    expect(outSince(out, before)).toContain('k=0 n=0');

    for (let i = 0; i < 3; i++) {
      const mark = markOut(out);
      expect(
        await runCli(
          ['record', '--id', 'r1', '--signal', 'APPLY', '--case-id', caseId, '--ensure'],
          env,
        ),
      ).toBe(0);
      expect(outSince(out, mark)).toContain(caseId);
    }

    const after = markOut(out);
    expect(await runCli(['show', '--id', 'r1'], env)).toBe(0);
    const shown = outSince(out, after);
    const branchLine = shown.split('\n').find((l) => l.includes(caseId));
    expect(branchLine).toBeDefined();
    // The whole point: branch evidence is no longer stuck at zero.
    expect(branchLine).toContain('k=3 n=3');
    expect(branchLine).toContain('[active]');
  });

  test('record --case-id naming no branch is refused, not folded into the rule', async () => {
    const { env, err, out } = fresh();
    await runCli(['init'], env);
    await decide(env, out, ['--id', 'r1', '--condition', 'root branch', '--apply']);

    expect(
      await runCli(
        ['record', '--id', 'r1', '--signal', 'APPLY', '--case-id', 'r1-dec-nope', '--ensure'],
        env,
      ),
    ).toBe(2);
    // The error must list the real branches, so a typo is recoverable without a second guess.
    expect(err()).toContain('r1-dec-');
    expect(err()).toContain('CORE_INVALID_ARGUMENT');
  });

  test('editing a branch without --parent keeps it nested (it used to be orphaned)', async () => {
    const { env, out } = fresh();
    await runCli(['init'], env);
    const root = await decide(env, out, ['--id', 'r1', '--condition', 'root', '--apply']);
    const child = await decide(env, out, [
      '--id',
      'r1',
      '--condition',
      'in app/Legacy',
      '--ignore',
      '--parent',
      root.caseId,
    ]);

    // Change the probability, deliberately omitting --parent.
    expect(
      await runCli(
        [
          'decision',
          '--id',
          'r1',
          '--condition',
          'in app/Legacy',
          '--probability',
          '0.4',
          '--case-id',
          child.caseId,
        ],
        env,
      ),
    ).toBe(0);

    const mark = markOut(out);
    expect(await runCli(['show', '--id', 'r1'], env)).toBe(0);
    const shown = outSince(out, mark);
    expect(shown).toContain('in app/Legacy -> probability(0.4)');
    // Still a child of root, one indent deeper.
    const rootLine = shown.split('\n').find((l) => l.includes('root ->'));
    const childLine = shown.split('\n').find((l) => l.includes('in app/Legacy ->'));
    expect(childLine?.match(/^\s*/)?.[0].length ?? 0).toBeGreaterThan(
      rootLine?.match(/^\s*/)?.[0].length ?? 0,
    );
  });

  test('--detach promotes a branch to the top level, and is refused with --parent', async () => {
    const { env, out, err } = fresh();
    await runCli(['init'], env);
    const root = await decide(env, out, ['--id', 'r1', '--condition', 'root', '--apply']);
    const child = await decide(env, out, [
      '--id',
      'r1',
      '--condition',
      'child',
      '--ignore',
      '--parent',
      root.caseId,
    ]);

    expect(
      await runCli(
        [
          'decision',
          '--id',
          'r1',
          '--condition',
          'child',
          '--ignore',
          '--case-id',
          child.caseId,
          '--detach',
        ],
        env,
      ),
    ).toBe(0);

    const mark = markOut(out);
    expect(await runCli(['show', '--id', 'r1'], env)).toBe(0);
    const lines = outSince(out, mark).split('\n');
    const rootLine = lines.find((l) => l.includes('root ->'));
    const childLine = lines.find((l) => l.includes('child ->'));
    expect(rootLine).toBeDefined();
    expect(childLine?.match(/^\s*/)?.[0].length ?? 0).toBe(
      rootLine?.match(/^\s*/)?.[0].length ?? 0,
    );

    // Contradictory request: refuse rather than pick a winner silently.
    expect(
      await runCli(
        [
          'decision',
          '--id',
          'r1',
          '--condition',
          'child',
          '--ignore',
          '--case-id',
          child.caseId,
          '--parent',
          root.caseId,
          '--detach',
        ],
        env,
      ),
    ).toBe(2);
    expect(err()).toContain('--detach/--parent');
  });

  test('--parent naming an unknown branch is refused instead of creating a root orphan', async () => {
    const { env, err, out } = fresh();
    await runCli(['init'], env);
    await decide(env, out, ['--id', 'r1', '--condition', 'root', '--apply']);

    expect(
      await runCli(
        [
          'decision',
          '--id',
          'r1',
          '--condition',
          'orphan attempt',
          '--apply',
          '--parent',
          'nope-123',
        ],
        env,
      ),
    ).toBe(2);
    expect(err()).toContain('decision.parentId');

    // Nothing was written: the tree still has exactly the one branch.
    const mark = markOut(out);
    expect(await runCli(['show', '--id', 'r1'], env)).toBe(0);
    expect(outSince(out, mark)).not.toContain('orphan attempt');
  });

  test('--case-id naming no branch is refused instead of minting a branch called by the typo', async () => {
    const { env, err, out } = fresh();
    await runCli(['init'], env);
    const root = await decide(env, out, ['--id', 'r1', '--condition', 'root', '--apply']);

    expect(
      await runCli(
        [
          'decision',
          '--id',
          'r1',
          '--condition',
          'revised root',
          '--ignore',
          '--case-id',
          'r1-dec-typo',
        ],
        env,
      ),
    ).toBe(2);
    expect(err()).toContain('decision.caseId');
    // The error has to carry the real id, or a mistyped edit is not recoverable.
    expect(err()).toContain(root.caseId);

    // Nothing was written and the real branch kept its decision.
    const mark = markOut(out);
    expect(await runCli(['show', '--id', 'r1'], env)).toBe(0);
    const rendered = outSince(out, mark);
    expect(rendered).not.toContain('revised root');
    expect(rendered).toContain('root -> apply');
  });

  test('a branch cannot be its own parent, nor re-parent under its own descendant', async () => {
    const { env, err, out } = fresh();
    await runCli(['init'], env);
    const root = await decide(env, out, ['--id', 'r1', '--condition', 'root', '--apply']);
    const child = await decide(env, out, [
      '--id',
      'r1',
      '--condition',
      'child',
      '--apply',
      '--parent',
      root.caseId,
    ]);

    expect(
      await runCli(
        [
          'decision',
          '--id',
          'r1',
          '--condition',
          'root',
          '--apply',
          '--case-id',
          root.caseId,
          '--parent',
          root.caseId,
        ],
        env,
      ),
    ).toBe(2);
    expect(err()).toContain('decision.parentId');

    // Re-parenting root under its own child would close a loop.
    expect(
      await runCli(
        [
          'decision',
          '--id',
          'r1',
          '--condition',
          'root',
          '--apply',
          '--case-id',
          root.caseId,
          '--parent',
          child.caseId,
        ],
        env,
      ),
    ).toBe(2);
    expect(err()).toContain('decision.parentId');
  });

  test('a duplicate condition under one parent is refused; under another parent it is not', async () => {
    const { env, err, out } = fresh();
    await runCli(['init'], env);
    const rootA = await decide(env, out, ['--id', 'r1', '--condition', 'root A', '--apply']);
    const rootB = await decide(env, out, ['--id', 'r1', '--condition', 'root B', '--apply']);
    await decide(env, out, [
      '--id',
      'r1',
      '--condition',
      'in legacy',
      '--ignore',
      '--parent',
      rootA.caseId,
    ]);

    // Same condition, same parent: refused, and the error names the sibling that already has it.
    expect(
      await runCli(
        [
          'decision',
          '--id',
          'r1',
          '--condition',
          'IN   Legacy',
          '--ignore',
          '--parent',
          rootA.caseId,
        ],
        env,
      ),
    ).toBe(2);
    expect(err()).toContain('decision.condition');

    // Same condition under a *different* parent is a genuinely different branch.
    expect(
      await runCli(
        [
          'decision',
          '--id',
          'r1',
          '--condition',
          'in legacy',
          '--ignore',
          '--parent',
          rootB.caseId,
        ],
        env,
      ),
    ).toBe(0);

    const mark = markOut(out);
    expect(await runCli(['show', '--id', 'r1'], env)).toBe(0);
    const shown = outSince(out, mark);
    expect(shown.split('\n').filter((l) => l.includes('in legacy')).length).toBe(2);
  });

  // GitHub #6: a gated write refused, then made by a human, then repeated, used to leave two
  // top-level branches with the same condition and different case ids.
  test('a refused gated write leaves no branch, and repeating the accepted condition is refused', async () => {
    const { env, err, out, root } = fresh();
    const cfg = join(root, 'gate.json');
    writeFileSync(
      cfg,
      JSON.stringify({
        kindSpecs: [{ name: 'rule', decisionPolicy: { requireHumanFor: ['ignore'] } }],
      }),
    );
    expect(await runCli(['init', '--config', cfg], env)).toBe(0);
    const args = ['--id', 'r1', '--condition', 'in legacy', '--ignore'];

    expect(await runCli(['decision', ...args, '--author', 'agent:reviewer'], env)).toBe(1);
    expect(err()).toContain('CORE_PERMISSION_DENIED');

    const accepted = await decide(env, out, [...args, '--author', 'human:nimish']);

    // Same top-level condition again, by any author: refused, naming the branch that has it.
    expect(await runCli(['decision', ...args, '--author', 'human:nimish'], env)).toBe(2);
    expect(err()).toContain('decision.condition');
    expect(err()).toContain(accepted.caseId);

    const mark = markOut(out);
    expect(await runCli(['show', '--id', 'r1'], env)).toBe(0);
    const shown = outSince(out, mark);
    expect(shown.split('\n').filter((l) => l.includes('in legacy')).length).toBe(1);
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

    // Restore from backup. GitHub #9: this used to print `episodes: 0 -> -1` into an empty store.
    const beforeRestore = out();
    expect(await runCli(['maintain', 'restore', backupPath], env)).toBe(0);
    const backup = JSON.parse(readFileSync(backupPath, 'utf8')) as {
      snapshot: { episodes: unknown[] };
    };
    const episodeCount = backup.snapshot.episodes.length;
    expect(out().slice(beforeRestore.length)).toContain(`episodes:   0 -> ${episodeCount}`);

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

  // GitHub #8: without annotations a client cannot tell reads from writes, or ask before a delete.
  test('every tool declares annotations: reads are read-only, remove_episode is destructive', async () => {
    const { env, root } = fresh();
    await runCli(['init'], env);
    const session = await connect(root);
    try {
      const tools = (await session.client.listTools()).tools;
      const byName = new Map(tools.map((t) => [t.name, t]));
      for (const tool of tools) {
        expect(tool.annotations?.openWorldHint).toBe(false);
        expect(typeof tool.annotations?.readOnlyHint).toBe('boolean');
      }
      const reads = ['hints', 'list_entities', 'show_entity', 'drift', 'simulate', 'status'];
      for (const name of [...reads, 'pack_context']) {
        expect(byName.get(name)?.annotations?.readOnlyHint).toBe(true);
      }
      const destructive = tools.filter((t) => t.annotations?.destructiveHint === true);
      expect(destructive.map((t) => t.name)).toEqual(['remove_episode']);
      expect(byName.get('record_signal')?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
      });
      expect(byName.get('remove_episode')?.inputSchema.required).toEqual(
        expect.arrayContaining(['seq', 'author', 'reason']),
      );
    } finally {
      await session.close();
    }
  });

  test('lists all thirteen tools and calls every tool with asserted results', async () => {
    const { env, root } = fresh();
    await runCli(['init'], env);
    await seedHome(env);

    const session = await connect(root);
    try {
      const { client } = session;
      const tools = (await client.listTools()).tools.map((t) => t.name);
      expect(tools).toHaveLength(14);
      expect(tools).toEqual(
        expect.arrayContaining([
          'hints',
          'list_entities',
          'show_entity',
          'record_signal',
          'report_guard',
          'record_decision',
          'propose',
          'drift',
          'simulate',
          'status',
          'retract_episode',
          'remove_episode',
          'pack_context',
          'primer',
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

      // 6. record_decision: build a branch, then attribute evidence to it via caseId
      const decRes = await call(client, 'record_decision', {
        id: 'mcp_dec_e',
        condition: 'under app/Http/Controllers',
        decision: { type: 'apply' },
      });
      expect(decRes.isError).toBe(false);
      expect(typeof decRes.body.caseId).toBe('string');
      expect(decRes.body.decisionTree).toBeDefined();
      const branchId = decRes.body.caseId as string;

      const branchSignal = await call(client, 'record_signal', {
        id: 'mcp_dec_e',
        signal: 'APPLY',
        ensure: true,
        caseId: branchId,
      });
      expect(branchSignal.isError).toBe(false);
      expect(branchSignal.body.caseId).toBe(branchId);

      // Editing by a caseId that names no branch is a typo, not a licence to mint one.
      const typoEdit = await call(client, 'record_decision', {
        id: 'mcp_dec_e',
        condition: 'somewhere else',
        decision: { type: 'ignore' },
        caseId: 'mcp_dec_e-dec-typo',
      });
      expect(typoEdit.isError).toBe(true);
      expect(typoEdit.body.error.code).toBe('CORE_INVALID_ARGUMENT');
      const afterTypo = await call(client, 'show_entity', { id: 'mcp_dec_e' });
      const branches = afterTypo.body.decisionTree as { id: string; condition: string }[];
      expect(branches.map((b) => b.id)).toEqual([branchId]);

      // 7. propose
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

      // 8. drift
      const driftRes = await call(client, 'drift', { limit: 5 });
      expect(driftRes.isError).toBe(false);
      expect(Array.isArray(driftRes.body.drifting)).toBe(true);
      expect(typeof driftRes.body.count).toBe('number');

      // 9. simulate
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

      // 11. remove_episode: author and reason are required (GitHub #8)
      const anonymous = await client.callTool({ name: 'remove_episode', arguments: { seq: 0 } });
      expect(anonymous.isError).toBe(true);
      const removeRes = await call(client, 'remove_episode', {
        seq: 0,
        author: 'mcp-agent',
        reason: 'mcp test removal',
      });
      expect(removeRes.isError).toBe(false);
      expect(removeRes.body.removed).toBe(true);

      // 12. pack_context
      const packRes = await call(client, 'pack_context', { budget: 500 });
      expect(packRes.isError).toBe(false);
      expect(packRes.body.totalCost).toBeDefined();
      expect(packRes.body.contextText).toBeDefined();

      // 13. primer
      const primerRes = await call(client, 'primer', { topic: 'signals' });
      expect(primerRes.isError).toBe(false);
      expect(primerRes.body.topic).toBe('signals');
      expect(primerRes.body.content).toContain('APPLY');
    } finally {
      await session.close();
    }
    expect(session.stderr()).toContain('medha mcp: serving');
  });

  test('subprocess stdio handshake: initialize -> tools/list -> clean exit on stdin close', async () => {
    const { env, root } = fresh();
    await runCli(['init'], env);

    const bin = join(import.meta.dir, 'bin.ts');
    const proc = spawn(process.execPath, [bin, 'mcp', 'serve', '--dir', root], {
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
          expect(msg.result?.tools).toHaveLength(14);
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

describe('medha mcp config', () => {
  const REGISTRY_IDS = ['claude-code', 'cursor', 'github-copilot', 'opencode', 'claude-desktop'];

  test('--list names every registry client, its scopes, and both launchers', async () => {
    const { env, out } = fresh();
    expect(await runCli(['mcp', 'config', '--list'], env)).toBe(0);
    const text = out();
    for (const id of REGISTRY_IDS) {
      expect(text).toContain(id);
    }
    expect(text).toContain('.mcp.json');
    expect(text).toContain('.cursor/mcp.json');
    expect(text).toContain('path');
    expect(text).toContain('npx');
    expect(text).toContain('https://cursor.com/docs/mcp');
  });

  test('--json --list emits the machine report', async () => {
    const { env, out } = fresh();
    expect(await runCli(['mcp', 'config', '--list', '--json'], env)).toBe(0);
    const report = JSON.parse(out()) as {
      clients: { id: string; scopes: { id: string }[] }[];
      launchers: { id: string }[];
    };
    expect(report.clients.map((c) => c.id)).toEqual(REGISTRY_IDS);
    expect(report.clients.every((c) => c.scopes.length > 0)).toBe(true);
    expect(report.launchers.map((l) => l.id)).toEqual(['path', 'npx']);
  });

  test('renders the default-scope snippet with docs, container, and server key', async () => {
    const { env, out } = fresh();
    expect(await runCli(['mcp', 'config', 'claude-code'], env)).toBe(0);
    const text = out();
    expect(text).toContain('https://code.claude.com/docs/en/mcp');
    expect(text).toContain('"mcpServers"');
    expect(text).toContain('"medha"');
    expect(text).toContain('"serve"');
    expect(text).toContain('medha on PATH');
  });

  test('renders the npx launcher with the resolved version, never the placeholder', async () => {
    const { env, out } = fresh();
    expect(await runCli(['mcp', 'config', 'cursor', '--launcher', 'npx'], env)).toBe(0);
    const text = out();
    expect(text).toContain(`@cntxt-labs/medha-cli@${VERSION}`);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the placeholder is gone.
    expect(text).not.toContain('${version}');
  });

  test('honours --scope for a non-default config file', async () => {
    const { env, out } = fresh();
    expect(await runCli(['mcp', 'config', 'cursor', '--scope', 'user'], env)).toBe(0);
    expect(out()).toContain('~/.cursor/mcp.json');
  });

  test('--write merges into an existing file keeping siblings, then reports no change', async () => {
    const { env, out, root } = fresh();
    mkdirSync(join(root, '.cursor'), { recursive: true });
    const target = join(root, '.cursor', 'mcp.json');
    writeFileSync(target, '{"mcpServers":{"other":{"command":"x"}},"foo":1}', 'utf8');
    expect(await runCli(['mcp', 'config', 'cursor', '--write'], env)).toBe(0);
    expect(out()).toContain('updated');
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({
      mcpServers: {
        other: { command: 'x' },
        medha: { type: 'stdio', command: 'medha', args: ['mcp', 'serve'] },
      },
      foo: 1,
    });
    expect(await runCli(['mcp', 'config', 'cursor', '--write'], env)).toBe(0);
    expect(out()).toContain('no change');
  });

  test('--write creates a missing file and container', async () => {
    const { env, out, root } = fresh();
    expect(await runCli(['mcp', 'config', 'claude-code', '--write'], env)).toBe(0);
    expect(out()).toContain('created');
    const written = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(written.mcpServers)).toEqual(['medha']);
  });

  test('a bare config with no client is usage (exit 2)', async () => {
    const { env, err } = fresh();
    expect(await runCli(['mcp', 'config'], env)).toBe(2);
    expect(err()).toContain('client');
  });

  test('--all and --write together are usage (exit 2)', async () => {
    const { env, err } = fresh();
    expect(await runCli(['mcp', 'config', '--all', '--write'], env)).toBe(2);
    expect(err()).toContain('--all');
  });

  test('--all --json renders every client exactly once', async () => {
    const { env, out } = fresh();
    expect(await runCli(['mcp', 'config', '--all', '--json'], env)).toBe(0);
    const reports = JSON.parse(out()) as { clientId: string }[];
    expect(reports.map((r) => r.clientId)).toEqual(REGISTRY_IDS);
  });

  test('bare medha mcp still fails as usage; config does not alias it', async () => {
    const { env } = fresh();
    expect(await runCli(['mcp'], env)).toBe(2);
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

describe('extensibility and resilient kind scoping (TASK-EXT-04 & TASK-EXT-05)', () => {
  test('gracefully preserves entities when an in-use custom kind is removed from config.json', async () => {
    const { env, root, out, err } = fresh();
    const configPath = join(root, 'custom-kinds.json');
    writeFileSync(configPath, JSON.stringify({ kinds: ['rule', 'flaky-test'] }));

    expect(await runCli(['init', '--config', configPath], env)).toBe(0);
    expect(
      await runCli(
        ['record', '--kind', 'flaky-test', '--id', 'test-1', '--signal', 'APPLY', '--ensure'],
        env,
      ),
    ).toBe(0);
    expect(
      await runCli(
        ['record', '--kind', 'rule', '--id', 'rule-1', '--signal', 'APPLY', '--ensure'],
        env,
      ),
    ).toBe(0);

    // Remove 'flaky-test' from config.json
    const homeConfigPath = join(root, '.medha', 'config.json');
    const cfg = JSON.parse(readFileSync(homeConfigPath, 'utf8'));
    cfg.registries.kinds = ['rule', 'recipe', 'prompt', 'skill', 'agent'];
    writeFileSync(homeConfigPath, JSON.stringify(cfg, null, 2));

    // medha list must NOT wipe out entities; lists both and marks unregistered
    const listOutBefore = out();
    expect(await runCli(['list'], env)).toBe(0);
    const listText = out().slice(listOutBefore.length);
    expect(listText).toContain('rule/rule-1');
    expect(listText).toContain('flaky-test/test-1');
    expect(listText).toContain('[unregistered kind]');
    expect(listText).toContain('warning: found 1 unregistered kind (flaky-test)');

    // medha maintain preflight reports entity count, ok integrity, and clear diagnostic guidance
    const preflightOutBefore = out();
    expect(await runCli(['maintain', 'preflight'], env)).toBe(0);
    const preflightText = out().slice(preflightOutBefore.length);
    expect(preflightText).toContain('status:     ok');
    expect(preflightText).toContain('entities:   2');
    expect(preflightText).toContain('integrity:  ok');
    expect(preflightText).toContain(
      "warning:    Found 1 entity with unregistered kind 'flaky-test'. Data is safe. Restore 'flaky-test' to registries or run 'medha maintain prune --kind flaky-test'.",
    );

    // New writes to the unregistered kind fail loud with UnknownKindError
    expect(
      await runCli(
        ['record', '--kind', 'flaky-test', '--id', 'test-2', '--signal', 'APPLY', '--ensure'],
        env,
      ),
    ).toBe(1);
    expect(err()).toContain("Unknown kind 'flaky-test'");
  });

  test('rejects conflicting redefinitions of canonical built-in signals', async () => {
    const { env, root, err } = fresh();
    const configPath = join(root, 'conflicting-signal.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        signalSpecs: [
          {
            name: 'APPLY',
            value: 0.5,
            countsAsTrial: true,
            countsAsSuccess: false, // Conflicts with canonical APPLY
            weight: 0.5,
          },
        ],
      }),
    );

    expect(await runCli(['init', '--config', configPath], env)).toBe(1);
    expect(err()).toContain('CLI_CONFIG_INVALID');
    expect(err()).toContain("cannot redefine built-in signal 'APPLY'");
  });

  test('TASK-EXT-02: per-kind trust configuration in config.json is reflected in params and explain-threshold', async () => {
    const { env, out } = fresh();
    const configPath = join(env.cwd, 'registries.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        kinds: {
          tool: {
            description: 'External LLM tools & MCP servers',
            thresholds: {
              trusted: 0.95,
              active: 0.7,
              minUsesForTrusted: 20,
            },
            recency: {
              halfLifeDays: 7,
            },
            evidenceWeighting: 'signal-value',
          },
        },
      }),
    );

    // Initialize with config
    expect(await runCli(['init', '--config', configPath], env)).toBe(0);

    // Check medha params reflects the configured kind overrides
    let before = out().length;
    expect(await runCli(['params'], env)).toBe(0);
    const paramsText = out().slice(before);
    expect(paramsText).toContain("kind 'tool'");
    expect(paramsText).toContain('0.95');
    expect(paramsText).toContain('signal-value');

    // Record a use on a tool entity
    expect(
      await runCli(
        ['record', '--kind', 'tool', '--id', 'calculator', '--signal', 'APPLY', '--ensure'],
        env,
      ),
    ).toBe(0);

    // Check explain-threshold reports the custom gates
    before = out().length;
    expect(await runCli(['explain-threshold', '--kind', 'tool', '--id', 'calculator'], env)).toBe(
      0,
    );
    const explainText = out().slice(before);
    expect(explainText).toContain('>= 0.95');
    expect(explainText).toContain('uses 1 >= 20');
  });

  test('TASK-EXT-03: sync pull rejects unconfigured custom kinds without --auto-import-registries', async () => {
    const repoA = fresh();
    const repoB = fresh();
    const syncFile = join(repoA.env.cwd, 'shared-sync.json');

    const configA = join(repoA.env.cwd, 'registries.json');
    writeFileSync(
      configA,
      JSON.stringify({
        kinds: ['service'],
        signalSpecs: [
          {
            name: 'LATENCY_SPIKE',
            value: -0.5,
            countsAsTrial: true,
            countsAsSuccess: false,
            description: 'Temporary latency degradation',
          },
        ],
      }),
    );

    // Repo A initializes with custom kind/signal, records entity, and pushes
    expect(await runCli(['init', '--config', configA], repoA.env)).toBe(0);
    expect(
      await runCli(
        [
          'record',
          '--kind',
          'service',
          '--id',
          'auth-api',
          '--signal',
          'LATENCY_SPIKE',
          '--ensure',
        ],
        repoA.env,
      ),
    ).toBe(0);
    expect(await runCli(['sync', 'push', '--file', syncFile], repoA.env)).toBe(0);

    // Repo B initializes standard home without service or LATENCY_SPIKE
    expect(await runCli(['init'], repoB.env)).toBe(0);

    // Repo B pulls without --auto-import-registries -> fails with CLI_SYNC_REGISTRY_MISMATCH
    expect(await runCli(['sync', 'pull', '--file', syncFile], repoB.env)).toBe(1);
    expect(repoB.err()).toContain('CLI_SYNC_REGISTRY_MISMATCH');
    expect(repoB.err()).toContain('service');
    expect(repoB.err()).toContain('LATENCY_SPIKE');
    expect(repoB.err()).toContain('--auto-import-registries');
  });

  test('TASK-EXT-03: sync pull auto-imports custom kinds and signals with --auto-import-registries', async () => {
    const repoA = fresh();
    const repoB = fresh();
    const syncFile = join(repoA.env.cwd, 'shared-sync.json');

    const configA = join(repoA.env.cwd, 'registries.json');
    writeFileSync(
      configA,
      JSON.stringify({
        kinds: ['service'],
        signalSpecs: [
          {
            name: 'LATENCY_SPIKE',
            value: -0.5,
            countsAsTrial: true,
            countsAsSuccess: false,
            description: 'Temporary latency degradation',
          },
        ],
      }),
    );

    // Repo A setup & push
    expect(await runCli(['init', '--config', configA], repoA.env)).toBe(0);
    expect(
      await runCli(
        [
          'record',
          '--kind',
          'service',
          '--id',
          'auth-api',
          '--signal',
          'LATENCY_SPIKE',
          '--ensure',
        ],
        repoA.env,
      ),
    ).toBe(0);
    expect(await runCli(['sync', 'push', '--file', syncFile], repoA.env)).toBe(0);

    // Repo B initializes standard home
    expect(await runCli(['init'], repoB.env)).toBe(0);

    // Repo B pulls with --auto-import-registries -> succeeds!
    expect(
      await runCli(['sync', 'pull', '--file', syncFile, '--auto-import-registries'], repoB.env),
    ).toBe(0);

    // Verify Repo B config.json was updated with imported kinds and signals
    const configBPath = join(repoB.env.cwd, '.medha', 'config.json');
    const configB = JSON.parse(readFileSync(configBPath, 'utf8'));
    expect(configB.registries.kinds).toContain('service');
    expect(
      configB.registries.signalSpecs.some((s: { name: string }) => s.name === 'LATENCY_SPIKE'),
    ).toBe(true);

    // Verify Repo B can list the imported entity
    const beforeList = repoB.out().length;
    expect(await runCli(['list', '--kind', 'service'], repoB.env)).toBe(0);
    const listOutput = repoB.out().slice(beforeList);
    expect(listOutput).toContain('service/auth-api');
  });

  describe('medha issue command', () => {
    test('issue prepares a GitHub issue with sanitized diagnostics (--json)', async () => {
      const repo = fresh();
      expect(await runCli(['init'], repo.env)).toBe(0);

      const before = repo.out().length;
      expect(
        await runCli(['issue', 'Fix unexpected drift warning', '--no-open', '--json'], repo.env),
      ).toBe(0);
      const output = repo.out().slice(before);
      const data = JSON.parse(output);

      expect(data.title).toBe('Fix unexpected drift warning');
      expect(data.url).toContain('https://github.com/nimishph/medha/issues/new');
      expect(data.body).toContain('### Diagnostics (Sanitized)');
      expect(data.body).toContain('Medha Version');
      expect(data.body).toContain('Platform');
      expect(data.body).toContain('backend: sqlite');
      expect(data.body).not.toContain(repo.env.cwd);
    });

    test('issue works without initialized home and renders text output', async () => {
      const repo = fresh();

      const before = repo.out().length;
      expect(await runCli(['issue', 'Bug', 'report', 'uninitialized', '--no-open'], repo.env)).toBe(
        0,
      );
      const output = repo.out().slice(before);

      expect(output).toContain('medha: prepared issue on GitHub:');
      expect(output).toContain('title: Bug report uninitialized');
      expect(output).toContain('url:   https://github.com/nimishph/medha/issues/new');
    });
  });
});
