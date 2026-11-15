import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli.ts';
import type { Environment } from './environment.ts';

/** `medha keys …` and signing through the CLI (medha-nwf.4). */

let cleanups: string[] = [];
afterEach(() => {
  Bun.gc(true);
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  cleanups = [];
});

function fresh() {
  const root = join(tmpdir(), `medha-keys-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  cleanups.push(root);
  let out = '';
  let clock = Date.UTC(2026, 8, 23);
  const env: Environment = {
    cwd: root,
    env: { MEDHA_KEY_DIR: join(root, 'private-keys') },
    now: () => (clock += 1000),
    isTTY: false,
    exitCode: 0,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      out += text;
    },
  };
  const run = async (...argv: string[]) => {
    out = '';
    const code = await runCli(argv, env);
    return { code, out };
  };
  return { root, home: join(root, '.medha'), run };
}

function keyring(home: string): { keys: { keyId: string; principal: string }[] } {
  return JSON.parse(readFileSync(join(home, 'keys', 'keyring.json'), 'utf8'));
}

describe('medha keys', () => {
  test('generate keeps the private key out of the home and makes it the default', async () => {
    const { root, home, run } = fresh();
    expect((await run('init')).code).toBe(0);
    const generated = await run('keys', 'generate', '--principal', 'human:ada', '--role', 'human');
    expect(generated.code).toBe(0);
    const [key] = keyring(home).keys;
    expect(key?.principal).toBe('human:ada');
    expect(existsSync(join(root, 'private-keys', `${key?.keyId.replace(':', '_')}.key`))).toBe(
      true,
    );
    expect(readFileSync(join(home, 'keys', 'keyring.json'), 'utf8')).not.toContain('PRIVATE');
    const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    expect(config.signing).toEqual({ mode: 'off', defaultKey: key?.keyId });
  });

  test('require mode: signed writes count, legacy ones only after adopt, revocation disowns', async () => {
    const { run } = fresh();
    await run('init');
    await run('record', '--id', 'r1', '--signal', 'APPLY', '--ensure', '--author', 'alice');
    await run('keys', 'generate', '--principal', 'agent:ci', '--role', 'agent,maintainer');
    expect((await run('record', '--id', 'r1', '--signal', 'APPLY')).code).toBe(0);
    const refused = await run('record', '--id', 'r1', '--signal', 'APPLY', '--author', 'mallory');
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("not the signing key's principal");

    const verify = JSON.parse((await run('keys', 'verify', '--json')).out);
    expect(verify).toMatchObject({ total: 2, verified: 1, unsigned: 1 });

    await run('keys', 'mode', 'require');
    const before = JSON.parse((await run('show', '--id', 'r1', '--json')).out);
    expect(before.detail.known).toBe(false); // the unsigned --ensure episode no longer counts

    expect((await run('keys', 'adopt')).code).toBe(0);
    const after = JSON.parse((await run('show', '--id', 'r1', '--json')).out);
    expect(after.detail.hint.evidence).toMatchObject({ successes: 2, totalTrials: 2 });

    const list = JSON.parse((await run('keys', 'list', '--json')).out);
    const keyId = list.keys[0].keyId as string;
    await run('keys', 'revoke', keyId, '--reason', 'laptop lost');
    const revoked = JSON.parse((await run('keys', 'verify', '--json')).out);
    expect(revoked.verified).toBe(0);
    const gone = JSON.parse((await run('show', '--id', 'r1', '--json')).out);
    expect(gone.detail.known).toBe(false);
  });

  test('rotation keeps past episodes valid and deletes the old private key', async () => {
    const { root, run } = fresh();
    await run('init');
    await run('keys', 'generate', '--principal', 'agent:ci');
    await run('record', '--id', 'r1', '--signal', 'APPLY', '--ensure');
    const old = JSON.parse((await run('keys', 'list', '--json')).out).keys[0].keyId as string;
    const rotated = JSON.parse((await run('keys', 'rotate', old, '--json')).out);
    expect(rotated.deletedOldPrivateKey).toBe(true);
    expect(existsSync(join(root, 'private-keys', `${old.replace(':', '_')}.key`))).toBe(false);
    await run('record', '--id', 'r1', '--signal', 'APPLY');
    const verify = JSON.parse((await run('keys', 'verify', '--json')).out);
    expect(verify).toMatchObject({ total: 2, verified: 2 });
  });

  test('a malformed signing config is refused', async () => {
    const { run, home } = fresh();
    await run('init');
    const path = join(home, 'config.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    await Bun.write(path, JSON.stringify({ ...config, signing: { mode: 'strict' } }));
    const listed = await run('list');
    expect(listed.code).not.toBe(0);
    expect(listed.out).toContain('signing.mode');
  });
});
