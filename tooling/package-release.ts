#!/usr/bin/env bun
/**
 * Build the distributable for this machine's platform: the compiled standalone binary.
 *
 *   bun run tooling/package-release.ts [--out dist] [--target darwin-x64]
 *
 * Result: `<out>/medha-<version>-<platform>-<arch>/medha[.exe]`, `<out>/medha/medha[.exe]` and the same
 * program as an npm package in `<out>/npm/medha-<platform>-<arch>/`.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PLATFORMS, platformPackage } from './platforms.ts';

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

// Copy license, readme and agent skill if present
for (const file of ['README.md', 'LICENSE', 'SKILL.md']) {
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
const tarCode = await tarChild.exited;
if (tarCode !== 0) {
  process.stderr.write(`tar failed with exit code ${tarCode}\n`);
  process.exit(tarCode ?? 1);
}
process.stdout.write(`Archived: ${join(out, archive)}\n`);

// The same program as an npm package for this target, which the launcher package depends on.
const [targetOs, targetCpu] = target.split('-');
const platform = PLATFORMS.find((p) => p.os === targetOs && p.cpu === targetCpu);
if (platform === undefined) {
  process.stderr.write(
    `No npm package for ${target}; known: ${PLATFORMS.map((p) => `${p.os}-${p.cpu}`).join(', ')}\n`,
  );
  process.exit(1);
}
const npmName = platformPackage(platform);
const npmFolder = join(out, 'npm', npmName.split('/')[1] as string);
rmSync(npmFolder, { recursive: true, force: true });
mkdirSync(join(npmFolder, 'bin'), { recursive: true });
const npmBinPath = join(npmFolder, 'bin', program);
cpSync(targetPath, npmBinPath);
if (!isWin) {
  try {
    chmodSync(targetPath, 0o755);
    chmodSync(npmBinPath, 0o755);
  } catch (error) {
    process.stderr.write(`warning: could not set executable permissions: ${error}\n`);
  }
}
if (existsSync(join(baseRoot, 'LICENSE'))) {
  cpSync(join(baseRoot, 'LICENSE'), join(npmFolder, 'LICENSE'));
}
await Bun.write(
  join(npmFolder, 'package.json'),
  `${JSON.stringify(
    {
      name: npmName,
      version,
      description: `The medha program for ${platform.os} on ${platform.cpu}. Install @cntxt-labs/medha-cli instead.`,
      license: 'MIT',
      author: { name: 'nimishph', url: 'https://github.com/nimishph' },
      homepage: 'https://github.com/nimishph/medha#readme',
      repository: { type: 'git', url: 'git+https://github.com/nimishph/medha.git' },
      bugs: { url: 'https://github.com/nimishph/medha/issues' },
      os: [platform.os],
      cpu: [platform.cpu],
      files: ['bin', 'LICENSE'],
      publishConfig: { access: 'public' },
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(`npm package: ${npmFolder}\n`);
