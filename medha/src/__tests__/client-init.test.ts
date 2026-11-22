import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MedhaClient } from '../client.ts';

// MedhaClient.init: the SDK can create a home on disk instead of needing `medha init` first
// (0.8.0-alpha.1 black-box finding: open() on an empty directory was the only option, and it threw).
describe('MedhaClient.init', () => {
  let dir: string;
  const clients: MedhaClient[] = [];
  const track = (client: MedhaClient): MedhaClient => {
    clients.push(client);
    return client;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'medha-sdk-init-'));
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.engine.close();
    // Best effort, as in client.test.ts: on Windows bun:sqlite can hold the WAL files briefly
    // after close, and a leftover temp directory is not a test failure.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      void err;
    }
  });

  test('creates a sqlite home that open() and a later init() both read', async () => {
    const client = track(await MedhaClient.init({ dir }));
    const hint = await client.recordAcceptance('no-console-log');
    expect(hint.trustScore).toBeCloseTo(0.103272, 6);
    await client.engine.close();
    clients.length = 0;

    const home = join(dir, '.medha');
    const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    expect(config.layoutVersion).toBe(1);
    expect(config.backend).toBe('sqlite');
    expect(config.path).toBe('store.sqlite');
    expect(config.registries.kinds).toEqual(['rule', 'recipe', 'tool']);
    expect(existsSync(join(home, 'store.sqlite'))).toBe(true);
    const gitignore = readFileSync(join(home, '.gitignore'), 'utf8');
    expect(gitignore).toContain('store.sqlite');
    expect(gitignore).not.toContain('config.json\n');

    const reopened = track(await MedhaClient.open({ dir }));
    expect((await reopened.show('no-console-log')).hint.evidence.successes).toBe(1);
    await reopened.engine.close();
    clients.length = 0;

    const again = track(await MedhaClient.init({ dir }));
    expect((await again.show('no-console-log')).hint.evidence.successes).toBe(1);
  });

  test('creates a file-backend home', async () => {
    const client = track(await MedhaClient.init({ dir, backend: 'file' }));
    await client.recordAcceptance('r');
    const config = JSON.parse(readFileSync(join(dir, '.medha', 'config.json'), 'utf8'));
    expect(config.backend).toBe('file');
    expect(config.path).toBe('state.jsonl');
    expect(existsSync(join(dir, '.medha', 'state.jsonl'))).toBe(true);
  });

  test('registers custom kinds named only by a kind spec', async () => {
    const client = track(
      await MedhaClient.init({
        dir,
        kindSpecs: [{ name: 'lint', thresholds: { active: 0.15 } }],
      }),
    );
    const hint = await client.recordAcceptance('lint:prefer-const');
    expect(hint.key.kind).toBe('lint');
    const config = JSON.parse(readFileSync(join(dir, '.medha', 'config.json'), 'utf8'));
    expect(config.registries.kinds).toContain('lint');
  });

  test('honours a custom home directory', async () => {
    track(await MedhaClient.init({ dir, home: 'state/medha-home' }));
    expect(existsSync(join(dir, 'state', 'medha-home', 'config.json'))).toBe(true);
    expect(existsSync(join(dir, '.medha'))).toBe(false);
  });

  test('rejects registries that differ from an existing home instead of ignoring them', async () => {
    const first = track(await MedhaClient.init({ dir }));
    await first.engine.close();
    clients.length = 0;
    await expect(MedhaClient.init({ dir, kindSpecs: [{ name: 'lint' }] })).rejects.toThrow(
      /registries/,
    );
    await expect(MedhaClient.init({ dir, namespaceScope: ['team-a'] })).rejects.toThrow(
      /namespaceScope/,
    );
  });

  test('rejects an unknown backend and an empty namespace scope', async () => {
    await expect(
      MedhaClient.init({ dir, backend: 'memory' as unknown as 'sqlite' }),
    ).rejects.toThrow(/backend/);
    await expect(MedhaClient.init({ dir, namespaceScope: [' '] })).rejects.toThrow(/namespace/);
    expect(existsSync(join(dir, '.medha'))).toBe(false);
  });
});
