#!/usr/bin/env node
'use strict';
// The command a package manager links onto the PATH. The program itself is a compiled binary in
// a per-platform package (`@cntxt-labs/medha-<os>-<cpu>`), installed alongside this one because
// this package lists them all as optional dependencies and a package manager keeps only the one
// that matches the machine. This file finds it and runs it.

const { spawnSync } = require('node:child_process');
const { chmodSync } = require('node:fs');
const path = require('node:path');

const SUPPORTED = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64', 'win32-x64'];

/** The package that holds the program for a platform, or `undefined` when there is none. */
function platformPackage(platform, cpu) {
  const key = `${platform}-${cpu}`;
  return SUPPORTED.includes(key) ? `@cntxt-labs/medha-${key}` : undefined;
}

/** Where the installed program is, or why it cannot be found. */
function locate(platform, cpu, resolve) {
  if (process.env.MEDHA_BINARY_PATH) {
    return { program: process.env.MEDHA_BINARY_PATH };
  }
  const name = platformPackage(platform, cpu);
  if (name === undefined) {
    return {
      problem: `medha has no build for ${platform} on ${cpu}. It runs on: ${SUPPORTED.join(', ')}.`,
    };
  }
  const file = platform === 'win32' ? 'medha.exe' : 'medha';
  try {
    return { program: resolve(`${name}/bin/${file}`) };
  } catch (failure) {
    return {
      problem:
        `The ${name} package is not installed (${failure.code ?? failure.message}). ` +
        'It is an optional dependency of @cntxt-labs/medha-cli: reinstall without --no-optional, or ' +
        `install ${name} directly.`,
    };
  }
}

/**
 * Restore the executable bit on the program, and say whether it worked.
 *
 * The published tarball is supposed to carry mode 0755, but a package can still arrive without it:
 * an install that strips permissions, a copy through a filesystem or archive tool that does not keep
 * them, or a version published before the mode was fixed. The program is always a program, so the
 * bit is safe to set here — this is the difference between a one-line `chmod` the user has to guess
 * and a command that just runs.
 */
function makeExecutable(program) {
  try {
    chmodSync(program, 0o755);
    return true;
  } catch {
    return false;
  }
}

/** True when a spawn failed only because the file was not executable. */
function isPermissionFailure(error) {
  return error !== undefined && error !== null && error.code === 'EACCES';
}

function main() {
  const found = locate(process.platform, process.arch, require.resolve);
  if (found.problem !== undefined) {
    process.stderr.write(`medha: ${found.problem}\n`);
    process.exitCode = 1;
    return;
  }
  const run = () =>
    spawnSync(found.program, process.argv.slice(2), { stdio: 'inherit', cwd: process.cwd() });

  let child = run();
  if (
    isPermissionFailure(child.error) &&
    process.platform !== 'win32' &&
    makeExecutable(found.program)
  ) {
    child = run();
  }
  if (child.error) {
    process.stderr.write(
      `medha: could not start ${path.basename(found.program)}: ${child.error.message}\n`,
    );
    if (isPermissionFailure(child.error)) {
      process.stderr.write(
        `hint: ${found.program} is not executable and medha could not make it so. ` +
          `Run: chmod +x "${found.program}"\n`,
      );
    }
    process.exitCode = 1;
    return;
  }
  if (child.signal) {
    process.kill(process.pid, child.signal);
    return;
  }
  process.exitCode = child.status ?? 1;
}

module.exports = { SUPPORTED, platformPackage, locate, makeExecutable, isPermissionFailure };

if (require.main === module) main();
