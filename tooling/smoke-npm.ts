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
  const usage = await run(['frobnicate']);
  check(
    'a failing command exits non-zero through the launcher',
    usage.code !== 0,
    `exit ${usage.code}`,
  );
} finally {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

if (failures.length > 0) {
  process.stderr.write(`\n${failures.join('\n\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('\nThe npm layout works.\n');
}
