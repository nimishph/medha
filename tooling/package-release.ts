#!/usr/bin/env bun
/**
 * Build the distributable for this machine's platform: the compiled standalone binary.
 *
 *   bun run tooling/package-release.ts [--out dist] [--target darwin-x64]
 *
 * Result: `<out>/medha-<version>-<platform>-<arch>/medha[.exe]` and `<out>/medha/medha[.exe]`.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const baseRoot = resolve(import.meta.dir, '..');
const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    target: { type: 'string' },
  },
});
const out = resolve(baseRoot, values.out ?? 'dist');
const version = (
  JSON.parse(readFileSync(join(baseRoot, 'cli', 'package.json'), 'utf8')) as { version: string }
).version;
const target = values.target ?? `${process.platform}-${process.arch}`;
const folderName = `medha-${version}-${target}`;
const folder = join(out, folderName);
const canonicalFolder = join(out, 'medha');

rmSync(folder, { recursive: true, force: true });
mkdirSync(folder, { recursive: true });
mkdirSync(canonicalFolder, { recursive: true });

const isWin = target.startsWith('win32') || (!values.target && process.platform === 'win32');
const program = isWin ? 'medha.exe' : 'medha';
const targetPath = join(folder, program);
const canonicalPath = join(canonicalFolder, program);

process.stdout.write(`Compiling medha CLI/MCP binary for ${target}...\n`);

const compileArgs = ['bun', 'build', '--compile'];
if (values.target) {
  compileArgs.push(`--target=bun-${values.target}`);
}
compileArgs.push('./src/bin.ts', '--outfile', targetPath);

const child = Bun.spawn({
  cmd: compileArgs,
  cwd: join(baseRoot, 'cli'),
  stdout: 'inherit',
  stderr: 'inherit',
});

const code = await child.exited;
if (code !== 0) {
  process.stderr.write(`bun build --compile failed with exit code ${code}\n`);
  process.exit(code ?? 1);
}

// Copy license and readme if present
for (const file of ['README.md', 'LICENSE']) {
  const src = join(baseRoot, file);
  if (existsSync(src)) cpSync(src, join(folder, file));
}

// Copy to canonical dist/medha/ folder for local launcher if host architecture
if (!values.target || values.target === `${process.platform}-${process.arch}`) {
  cpSync(targetPath, canonicalPath, { force: true });
  process.stdout.write(`Successfully built:\n  ${targetPath}\n  ${canonicalPath}\n`);
} else {
  process.stdout.write(`Successfully built:\n  ${targetPath}\n`);
}

// Create compressed archive for distribution
const archive = isWin ? `${folderName}.zip` : `${folderName}.tar.gz`;
rmSync(join(out, archive), { force: true });
const tarChild = Bun.spawn({
  cmd: isWin
    ? ['tar', '-a', '-c', '-f', archive, folderName]
    : ['tar', '-czf', archive, folderName],
  cwd: out,
  stdout: 'inherit',
  stderr: 'inherit',
});
await tarChild.exited;
process.stdout.write(`Archived: ${join(out, archive)}\n`);
