#!/usr/bin/env bun
/**
 * Install the packages as a user's package manager would lay them out, and run the command that
 * `npm install -g @cntxt-labs/medha-cli` would link: the launcher, which finds the program in the
 * platform package.
 *
 *   bun run tooling/smoke-npm.ts [--dist dist]
 *
 * It needs `bun run build` first. It does not touch the network: the two packages are copied into
 * a `node_modules` folder, which is the layout an install produces.
 */
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { programMode } from './npm-tarball.ts';
import { MAIN_PACKAGE, PLATFORMS, platformPackage } from './platforms.ts';

const root = resolve(import.meta.dir, '..');
const { values } = parseArgs({ options: { dist: { type: 'string' } } });
const dist = resolve(root, values.dist ?? 'dist');
const program = process.platform === 'win32' ? 'medha.exe' : 'medha';
const here = PLATFORMS.find((p) => p.os === process.platform && p.cpu === process.arch);
if (!here) {
  process.stderr.write(
    `smoke-npm: no package for ${process.platform}-${process.arch}; known: ${PLATFORMS.map(platformPackage).join(', ')}\n`,
  );
  process.exit(1);
}
const platformFolder = join(dist, 'npm', platformPackage(here).split('/')[1] as string);
if (!existsSync(platformFolder)) {
  process.stderr.write(`smoke-npm: ${platformFolder} not found; run \`bun run build\` first\n`);
  process.exit(1);
}

const sandbox = mkdtempSync(join(tmpdir(), 'medha-npm-'));
const failures: string[] = [];
try {
  const modules = join(sandbox, 'node_modules');
  cpSync(join(root, 'cli', 'bin'), join(modules, MAIN_PACKAGE, 'bin'), { recursive: true });
  cpSync(join(root, 'cli', 'package.json'), join(modules, MAIN_PACKAGE, 'package.json'));
  cpSync(platformFolder, join(modules, platformPackage(here)), { recursive: true });
  const project = join(sandbox, 'project');
  mkdirSync(project, { recursive: true });

  const launcher = join(modules, MAIN_PACKAGE, 'bin', 'medha.cjs');
  const run = async (args: readonly string[]) => {
    const child = Bun.spawn({
      cmd: ['node', launcher, ...args],
      cwd: project,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { out, err, code };
  };
  const check = (step: string, ok: boolean, detail: string) => {
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${step}\n`);
    if (!ok) failures.push(`${step}\n${detail}`);
  };

  const version = await run(['--version']);
  check(
    'the launcher runs the program',
    version.code === 0 && /^medha \d/.test(version.out),
    version.out + version.err,
  );
  const init = await run(['init']);
  check(
    'it initialises through the launcher',
    init.code === 0 && init.out.includes('initialized'),
    init.out + init.err,
  );
  const status = await run(['status']);
  check(
    'it reads the store it created',
    status.code === 0 && status.out.includes('preflight:  ok'),
    status.out + status.err,
  );
  const list = await run(['list', '--json']);
  check(
    'it lists entities through the launcher',
    list.code === 0 && list.out.includes('"page"'),
    list.out + list.err,
  );
  const drift = await run(['drift']);
  check(
    'it checks drift through the launcher',
    drift.code === 0 && drift.out.includes('drift'),
    drift.out + drift.err,
  );
  const usage = await run(['frobnicate']);
  check(
    'a failing command exits non-zero through the launcher',
    usage.code !== 0,
    `exit ${usage.code}`,
  );

  // MCP stdio streaming check through the npm launcher
  const mcpServer = Bun.spawn({
    cmd: ['node', launcher, 'mcp', 'serve'],
    cwd: project,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const send = (message: unknown) => mcpServer.stdin.write(`${JSON.stringify(message)}\n`);
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-npm', version: '1.0' },
    },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  await mcpServer.stdin.flush();

  const reader = mcpServer.stdout.getReader();
  let seen = '';
  const decoder = new TextDecoder();
  while (!seen.includes('"id":2')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    seen += decoder.decode(chunk.value);
  }

  check(
    'serves MCP tools over stdio through launcher',
    seen.includes('"name":"hints"') &&
      seen.includes('"name":"list_entities"') &&
      seen.includes('"name":"propose"'),
    seen,
  );

  await mcpServer.stdin.end();
  const exited = await Promise.race([mcpServer.exited, Bun.sleep(10_000).then(() => undefined)]);
  check(
    'MCP server exits cleanly when stdin closes through launcher',
    exited === 0,
    `exit ${exited}`,
  );
  if (exited === undefined) {
    mcpServer.kill();
    await mcpServer.exited;
  }

  /*
   * The published tarball has to carry the executable bit, or every install ends in
   * `spawnSync .../bin/medha EACCES` (nimishph/medha#1). Copying the folder, as the checks above do,
   * cannot see this: the mode only becomes a fact when npm packs the package, so pack it for real
   * and read the mode out of the archive.
   */
  if (process.platform === 'win32') {
    process.stdout.write(
      'skip the tarball mode checks: an NTFS file has no executable bit, so a tarball built here ' +
        'cannot represent a correct one. The release job restores the bit before publishing.\n',
    );
  } else {
    const installed = join(modules, platformPackage(here), 'bin', program);
    const pack = Bun.spawn({
      cmd: ['npm', 'pack', '--pack-destination', sandbox, '--silent'],
      cwd: join(modules, platformPackage(here)),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [packOut, packErr, packCode] = await Promise.all([
      new Response(pack.stdout).text(),
      new Response(pack.stderr).text(),
      pack.exited,
    ]);
    check('the platform package packs', packCode === 0, packErr);
    if (packCode === 0) {
      /*
       * Take the tarball name from what `npm pack` just printed rather than rebuilding it here.
       * npm rewrites a scoped name when it names the file (`@cntxt-labs/medha-linux-x64` packs as
       * `cntxt-labs-medha-linux-x64-<version>.tgz`), so a hand-built name reads a file that was
       * never written and the mode check fails for a reason that has nothing to do with the mode.
       */
      const packed = packOut
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.endsWith('.tgz'))
        .pop();
      check(
        'npm reports the tarball it wrote',
        packed !== undefined,
        `npm pack said: ${packOut.trim()}`,
      );
      if (packed !== undefined) {
        const tarball = join(sandbox, packed);
        const mode = programMode(new Uint8Array(readFileSync(tarball)));
        check(
          `the packed tarball ships the program as 0755 (found ${mode?.toString(8) ?? 'nothing'})`,
          mode === 0o755,
          `read ${tarball}`,
        );
      }
    }

    /*
     * And the launcher must survive the installs that lose the bit anyway — a permission-stripping
     * package manager, a copy through an archive, or any version published before this was fixed.
     * This is the state a 0.5.0 user is actually in, so it is worth proving rather than assuming.
     */
    chmodSync(installed, 0o644);
    const healed = await run(['--version']);
    check(
      'it still runs when the executable bit was stripped, and puts the bit back',
      healed.code === 0 && /^medha \d/.test(healed.out) && (statSync(installed).mode & 0o111) !== 0,
      healed.out + healed.err,
    );
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

if (failures.length > 0) {
  process.stderr.write(`\n${failures.join('\n\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('\nThe npm layout works.\n');
}
