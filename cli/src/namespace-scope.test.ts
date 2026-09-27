import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Medha } from '@cntxt-labs/medha';
import { type EntityKey, InvalidArgumentError } from '@cntxt-labs/medha-core';
import { runCli } from './cli.ts';
import type { Environment } from './environment.ts';
import { readConfig, storeForConfig } from './layout.ts';
import { openHome } from './open.ts';

/**
 * `--namespace` end to end: an initialized home restricted to one namespace refuses to read or
 * write another namespace through the CLI/engine, while `sync`/`maintain`/`report`/`ui` — which use
 * `opened.store` directly (medha-nwf.6) — still see the whole underlying store.
 */

const NOW = Date.UTC(2026, 8, 27, 0, 0, 0);
let cleanups: readonly string[] = [];

afterEach(() => {
  const dirs = cleanups;
  cleanups = [];
  Bun.gc(true);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

function fresh(): { env: Environment; root: string; out: () => string; err: () => string } {
  const root = join(
    tmpdir(),
    `medha-nsscope-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
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
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      err += t;
    },
  };
  return { env, root, out: () => out, err: () => err };
}

/** Write directly under the raw (unscoped) store into a namespace `medha init --namespace` did not grant. */
async function seedForeignNamespace(env: Environment, namespace: string): Promise<void> {
  const config = readConfig(join(env.cwd, '.medha'));
  if (config === null) throw new InvalidArgumentError('home', 'an initialized home', config);
  const store = storeForConfig(config);
  const engine = new Medha({ store });
  try {
    const key: EntityKey = { namespace, kind: 'rule', id: 'foreign' };
    await engine.record(key, 'APPLY', { now: NOW }, { ensure: true });
  } finally {
    await engine.close();
  }
}

describe('medha init --namespace', () => {
  test('reports the configured scope and writes it to config.json', async () => {
    const { env, root, out } = fresh();
    expect(await runCli(['init', '--namespace', 'proj-a, proj-b'], env)).toBe(0);
    expect(out()).toContain('namespaces: proj-a, proj-b');
    const config = readConfig(join(root, '.medha'));
    expect(config?.namespaceScope).toEqual(['proj-a', 'proj-b']);
  });

  test('an empty --namespace value is a usage error, not a silently unrestricted home', async () => {
    const { env, err } = fresh();
    expect(await runCli(['init', '--namespace', ' , '], env)).toBe(2);
    expect(err()).toContain('--namespace');
  });

  test('a home without --namespace stays unrestricted', async () => {
    const { env, root, out } = fresh();
    expect(await runCli(['init'], env)).toBe(0);
    expect(out()).not.toContain('namespaces:');
    const config = readConfig(join(root, '.medha'));
    expect(config?.namespaceScope).toBeUndefined();
  });
});

describe('medha init --recreate on a namespace-scoped home', () => {
  test('carries the existing scope over instead of silently widening the home', async () => {
    const { env, root, out } = fresh();
    expect(await runCli(['init', '--namespace', 'proj-a'], env)).toBe(0);

    expect(await runCli(['init', '--recreate'], env)).toBe(0);
    expect(readConfig(join(root, '.medha'))?.namespaceScope).toEqual(['proj-a']);
    // The report says so, so preserving the boundary is never a silent no-op either.
    expect(out()).toContain('namespaces: proj-a');

    // And the recreated home is still actually scoped: the engine is not the admin engine.
    const opened = openHome(env.cwd);
    await expect(
      opened.engine.record(
        { namespace: 'proj-b', kind: 'rule', id: 'foreign' },
        'APPLY',
        { now: NOW },
        { ensure: true },
      ),
    ).rejects.toThrow(/namespace/i);
    await opened.engine.close();
  });

  test('--namespace on --recreate replaces the scope outright', async () => {
    const { env, root } = fresh();
    expect(await runCli(['init', '--namespace', 'proj-a'], env)).toBe(0);

    expect(await runCli(['init', '--recreate', '--namespace', 'proj-b,proj-c'], env)).toBe(0);
    expect(readConfig(join(root, '.medha'))?.namespaceScope).toEqual(['proj-b', 'proj-c']);
  });

  test('--no-namespace on --recreate drops the scope deliberately', async () => {
    const { env, root, out } = fresh();
    expect(await runCli(['init', '--namespace', 'proj-a'], env)).toBe(0);

    const before = out().length;
    expect(await runCli(['init', '--recreate', '--no-namespace'], env)).toBe(0);
    expect(readConfig(join(root, '.medha'))?.namespaceScope).toBeUndefined();
    expect(out().slice(before)).not.toContain('namespaces:');
    // Unscoped now, and visibly so: the whole store is reachable through the engine.
    const opened = openHome(env.cwd);
    await opened.engine.record(
      { namespace: 'proj-b', kind: 'rule', id: 'anything' },
      'APPLY',
      { now: NOW },
      { ensure: true },
    );
    expect((await opened.engine.list({}, { now: NOW })).items).toHaveLength(1);
    await opened.engine.close();
  });

  test('--namespace and --no-namespace together are a usage error', async () => {
    const { env, err, root } = fresh();
    expect(await runCli(['init', '--namespace', 'proj-a'], env)).toBe(0);
    expect(
      await runCli(['init', '--recreate', '--namespace', 'proj-b', '--no-namespace'], env),
    ).toBe(2);
    expect(err()).toContain('--no-namespace');
    // The home is untouched: the contradiction is caught before anything is wiped.
    expect(readConfig(join(root, '.medha'))?.namespaceScope).toEqual(['proj-a']);
  });

  test('--recreate on an unscoped home stays unscoped', async () => {
    const { env, root } = fresh();
    expect(await runCli(['init'], env)).toBe(0);
    expect(await runCli(['init', '--recreate'], env)).toBe(0);
    expect(readConfig(join(root, '.medha'))?.namespaceScope).toBeUndefined();
  });
});

describe('a namespace-scoped engine home', () => {
  test('list and show only ever surface the granted namespace', async () => {
    const { env, out } = fresh();
    await runCli(['init', '--namespace', 'proj-a'], env);
    const opened = openHome(env.cwd);
    await opened.engine.record(
      { namespace: 'proj-a', kind: 'rule', id: 'mine' },
      'APPLY',
      { now: NOW },
      { ensure: true },
    );
    await opened.engine.close();
    await seedForeignNamespace(env, 'proj-b');

    expect(await runCli(['list'], env)).toBe(0);
    const text = out();
    expect(text).toContain('proj-a/rule/mine');
    expect(text).not.toContain('proj-b');
    expect(text).not.toContain('foreign');

    expect(
      await runCli(['show', '--namespace', 'proj-b', '--kind', 'rule', '--id', 'foreign'], env),
    ).toBe(1);
  });

  test('record/reportGuard into a foreign namespace fail and touch nothing', async () => {
    const { env, err } = fresh();
    await runCli(['init', '--namespace', 'proj-a'], env);
    await seedForeignNamespace(env, 'proj-b');

    const before = readConfig(join(env.cwd, '.medha'));
    const store = storeForConfig(before as NonNullable<typeof before>);
    await store.open();
    const logBefore = (await store.episodes()).length;
    await store.close();

    expect(
      await runCli(
        [
          'record',
          '--namespace',
          'proj-b',
          '--kind',
          'rule',
          '--id',
          'foreign',
          '--signal',
          'APPLY',
        ],
        env,
      ),
    ).toBe(1);
    expect(err()).toMatch(/namespace/i);

    const after = storeForConfig(before as NonNullable<typeof before>);
    await after.open();
    expect((await after.episodes()).length).toBe(logBefore);
    await after.close();
  });

  test('maintenance commands (report) still see every namespace in the store', async () => {
    const { env, out } = fresh();
    await runCli(['init', '--namespace', 'proj-a'], env);
    const opened = openHome(env.cwd);
    await opened.engine.record(
      { namespace: 'proj-a', kind: 'rule', id: 'mine' },
      'APPLY',
      { now: NOW },
      { ensure: true },
    );
    await opened.engine.close();
    await seedForeignNamespace(env, 'proj-b');

    const before = out().length;
    expect(await runCli(['report', '--json'], env)).toBe(0);
    const outcome = JSON.parse(out().slice(before)) as {
      entityCount: number;
      episodeCount: number;
    };
    expect(outcome.entityCount).toBe(2);
    expect(outcome.episodeCount).toBe(2);
  });
});
