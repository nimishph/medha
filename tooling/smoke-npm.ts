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
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { MAIN_PACKAGE, PLATFORMS, platformPackage } from './platforms.ts';

const root = resolve(import.meta.dir, '..');
const { values } = parseArgs({ options: { dist: { type: 'string' } } });
const dist = resolve(root, values.dist ?? 'dist');

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
} finally {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

if (failures.length > 0) {
  process.stderr.write(`\n${failures.join('\n\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('\nThe npm layout works.\n');
}
