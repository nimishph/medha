#!/usr/bin/env bun
/**
 * Smoke test for the packaged sage binary against the todo-list project.
 * Runs init, list, status, drift headlessly, then verifies the MCP server
 * does a full JSON-RPC handshake (initialize -> tools/list) and exits cleanly
 * when stdin closes.
 *
 *   bun run tooling/smoke-package.ts [--dist dist]
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const baseRoot = resolve(import.meta.dir, '..');
const { values } = parseArgs({ options: { dist: { type: 'string' } } });
const dist = resolve(baseRoot, values.dist ?? 'dist');

// Find packaged binary
const programName = process.platform === 'win32' ? 'sage.exe' : 'sage';
let program: string | undefined;

const canonical = join(dist, 'sage', programName);
if (existsSync(canonical)) {
  program = canonical;
} else {
  const unpacked = readdirSync(dist, { withFileTypes: true }).find(
    (entry) => entry.isDirectory() && entry.name.startsWith('sage-'),
  );
  if (unpacked) {
    const candidate = join(dist, unpacked.name, programName);
    if (existsSync(candidate)) program = candidate;
  }
}

if (!program) {
  process.stderr.write(`smoke: could not find compiled ${programName} in ${dist}\n`);
  process.exit(1);
}
const executable = program;

// Copy todo-list project or scaffold a todo-list smoke workspace
const todoListSrc = 'E:/AI projects/todo-list';
const project = mkdtempSync(join(tmpdir(), 'sage-smoke-todo-list-'));

if (existsSync(todoListSrc)) {
  cpSync(join(todoListSrc, 'package.json'), join(project, 'package.json'));
  if (existsSync(join(todoListSrc, 'src'))) {
    cpSync(join(todoListSrc, 'src'), join(project, 'src'), { recursive: true });
  }
} else {
  mkdirSync(join(project, 'src'), { recursive: true });
  await Bun.write(join(project, 'package.json'), '{"name":"todo-list","version":"1.0.0"}');
  await Bun.write(join(project, 'src', 'index.ts'), 'export const todo = "item";\n');
}

interface Ran {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function run(args: readonly string[]): Promise<Ran> {
  const child = Bun.spawn({
    cmd: [executable, ...args],
    cwd: project,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, out, err };
}

const failures: string[] = [];
function expect(step: string, ok: boolean, ran?: Ran): void {
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${step}\n`);
  if (!ok) failures.push(`${step}${ran ? `\nstdout:\n${ran.out}\nstderr:\n${ran.err}` : ''}`);
}

try {
  // 1. Version
  const version = await run(['--version']);
  expect('prints version', version.code === 0 && /^sage \d+\.\d+\.\d+/.test(version.out), version);

  // 2. Init
  const init = await run(['init']);
  expect(
    'initializes engine home on todo-list',
    init.code === 0 && init.out.includes('initialized'),
    init,
  );

  // 3. List
  const list = await run(['list', '--json']);
  expect('lists entities headlessly', list.code === 0 && list.out.includes('"page"'), list);

  // 4. Status
  const status = await run(['status']);
  expect(
    'reports status with preflight ok',
    status.code === 0 && status.out.includes('preflight:  ok'),
    status,
  );

  // 5. Drift
  const drift = await run(['drift']);
  expect('reports drift headlessly', drift.code === 0 && drift.out.includes('drift'), drift);

  // 6. MCP serve with full handshake and exit on stdin close
  const server = Bun.spawn({
    cmd: [executable, 'mcp', 'serve'],
    cwd: project,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const send = (message: unknown) => server.stdin.write(`${JSON.stringify(message)}\n`);
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '1.0' },
    },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  await server.stdin.flush();

  const reader = server.stdout.getReader();
  let seen = '';
  const decoder = new TextDecoder();
  while (!seen.includes('"id":2')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    seen += decoder.decode(chunk.value);
  }

  expect(
    'serves MCP tools over stdio',
    seen.includes('"name":"hints"') &&
      seen.includes('"name":"list_entities"') &&
      seen.includes('"name":"propose"'),
    { code: 0, out: seen, err: '' },
  );

  // Close stdin to test clean exit
  await server.stdin.end();
  const exited = await Promise.race([server.exited, Bun.sleep(10_000).then(() => undefined)]);
  expect('MCP server exits cleanly when stdin closes', exited === 0);
  if (exited === undefined) {
    server.kill();
    await server.exited;
  }
} finally {
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

if (failures.length > 0) {
  process.stderr.write(`\nSmoke test failures:\n${failures.join('\n\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('\nAll smoke checks passed on todo-list!\n');
}
