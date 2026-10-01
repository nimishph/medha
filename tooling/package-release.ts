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
    rust: { type: 'boolean' },
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

const RUST_TARGET_MAP: Record<string, string> = {
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'win32-x64': 'x86_64-pc-windows-msvc',
};
const rustTarget = RUST_TARGET_MAP[target];
const isCross =
  values.target !== undefined && values.target !== `${process.platform}-${process.arch}`;

const cargoEnv: Record<string, string | undefined> = { ...process.env };
if (process.platform === 'win32') {
  const winlibs =
    'C:\\Users\\nimis\\AppData\\Local\\Microsoft\\WinGet\\Packages\\BrechtSanders.WinLibs.POSIX.MSVCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\\mingw64\\bin';
  if (existsSync(winlibs)) {
    cargoEnv.PATH = `${winlibs};${cargoEnv.PATH ?? ''}`;
  }
}

if (values.rust) {
  if (!isCross) {
    process.stdout.write('Compiling native Rust medha-napi binding via Cargo...\n');
    const napiChild = Bun.spawn({
      cmd: ['cargo', 'build', '--release', '-p', 'medha-napi'],
      cwd: baseRoot,
      env: cargoEnv,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const napiCode = await napiChild.exited;
    if (napiCode !== 0) {
      process.stderr.write(
        `cargo build --release -p medha-napi failed with exit code ${napiCode}\n`,
      );
      process.exit(napiCode ?? 1);
    }
    const libName = isWin
      ? 'medha_napi.dll'
      : process.platform === 'darwin'
        ? 'libmedha_napi.dylib'
        : 'libmedha_napi.so';
    const builtLib = join(baseRoot, 'target', 'release', libName);
    if (existsSync(builtLib)) {
      cpSync(builtLib, join(baseRoot, 'target', 'release', 'medha_napi.node'), { force: true });
      cpSync(builtLib, join(baseRoot, 'crates', 'medha-napi', 'medha_napi.node'), { force: true });
    }
  }

  process.stdout.write(`Compiling native Rust medha CLI/MCP binary for ${target} via Cargo...\n`);
  const cargoArgs = ['cargo', 'build', '--release', '-p', 'medha-cli', '--bin', 'medha'];
  if (isCross && rustTarget) {
    cargoArgs.push('--target', rustTarget);
  }
  const child = Bun.spawn({
    cmd: cargoArgs,
    cwd: baseRoot,
    env: cargoEnv,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await child.exited;
  if (code !== 0) {
    process.stderr.write(`cargo build --release failed with exit code ${code}\n`);
    process.exit(code ?? 1);
  }
  const builtBinary =
    isCross && rustTarget
      ? join(baseRoot, 'target', rustTarget, 'release', program)
      : join(baseRoot, 'target', 'release', program);
  cpSync(builtBinary, targetPath, { force: true });
} else {
  process.stdout.write(`Compiling medha CLI/MCP binary for ${target}...\n`);

  const compileArgs = ['bun', 'build', '--compile', '--minify', '--sourcemap=none'];
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
  // This is what makes the release archive (`<folder>.tar.gz`, created below) usable as-is, and it
  // makes a locally packed npm folder usable too.
  //
  // It is NOT enough on its own for the npm publish path, because `actions/upload-artifact` stores
  // files in a zip and does not carry the permission bits across the job boundary — the `release`
  // job re-applies the mode before it publishes (see .github/workflows/release.yml). Two notes so
  // nobody "fixes" this the obvious wrong way:
  //
  // - Do not add a `bin` field to the platform package to work around it. npm derives nothing from
  //   `bin` when packing (its portable mode only clears write bits, so it preserves whatever the
  //   file already has), and a second package claiming the `medha` bin name races the launcher's
  //   own `bin` for `node_modules/.bin/medha` — sometimes linking the raw binary, sometimes the
  //   launcher, depending on install order.
  // - The launcher chmods the program on EACCES anyway, so an install that loses the bit for any
  //   other reason still works. That is the layer that reaches users on a version published before
  //   this was fixed.
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
