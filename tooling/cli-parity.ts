#!/usr/bin/env bun
/**
 * The CLI parity gate (plan/rust-cli-parity): build the Rust `medha` binary and run the TypeScript
 * CLI suite (`cli/src`) through it via MEDHA_CLI_BINARY, so the Rust CLI is held to the reference
 * CLI's behaviour. Extra arguments go to `bun test` (e.g. a test-name filter with `-t`).
 *
 *   bun run test:cli-parity
 *   bun tooling/cli-parity.ts -t "write plane"   (filters: call the script directly on Windows)
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const build = Bun.spawnSync(['cargo', 'build', '-p', 'medha-cli', '--bin', 'medha'], {
  cwd: root,
  stdout: 'inherit',
  stderr: 'inherit',
});
if (build.exitCode !== 0) {
  process.stderr.write('cli-parity: cargo build failed\n');
  process.exit(build.exitCode ?? 1);
}

const binary = join(root, 'target', 'debug', process.platform === 'win32' ? 'medha.exe' : 'medha');
if (!existsSync(binary)) {
  process.stderr.write(`cli-parity: no binary at ${binary}\n`);
  process.exit(1);
}

const run = Bun.spawnSync(['bun', 'test', 'cli/src', ...process.argv.slice(2)], {
  cwd: root,
  env: { ...process.env, MEDHA_CLI_BINARY: binary },
  stdout: 'inherit',
  stderr: 'inherit',
});
process.exit(run.exitCode ?? 1);
