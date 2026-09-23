#!/usr/bin/env bun
/**
 * Build the distributable for this machine's platform: the compiled standalone binary.
 *
 *   bun run tooling/package-release.ts [--out dist]
 *
 * Result: `<out>/sage-<version>-<platform>-<arch>/sage[.exe]` and `<out>/sage/sage[.exe]`.
 */
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const baseRoot = resolve(import.meta.dir, '..');
const { values } = parseArgs({ options: { out: { type: 'string' } } });
const out = resolve(baseRoot, values.out ?? 'dist');
const version = (
  JSON.parse(readFileSync(join(baseRoot, 'cli', 'package.json'), 'utf8')) as { version: string }
).version;
const target = `${process.platform}-${process.arch}`;
const folder = join(out, `sage-${version}-${target}`);
const canonicalFolder = join(out, 'sage');

rmSync(folder, { recursive: true, force: true });
mkdirSync(folder, { recursive: true });
mkdirSync(canonicalFolder, { recursive: true });

const program = process.platform === 'win32' ? 'sage.exe' : 'sage';
const targetPath = join(folder, program);
const canonicalPath = join(canonicalFolder, program);

process.stdout.write(`Compiling sage CLI/MCP binary for ${target}...\n`);

const child = Bun.spawn({
  cmd: ['bun', 'build', '--compile', './src/bin.ts', '--outfile', targetPath],
  cwd: join(baseRoot, 'cli'),
  stdout: 'inherit',
  stderr: 'inherit',
});

const code = await child.exited;
if (code !== 0) {
  process.stderr.write(`bun build --compile failed with exit code ${code}\n`);
  process.exit(code ?? 1);
}

// Copy to canonical dist/sage/ folder for local launcher
cpSync(targetPath, canonicalPath, { force: true });
process.stdout.write(`Successfully built:\n  ${targetPath}\n  ${canonicalPath}\n`);
