#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SUPPORTED = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'win32-x64'];

function platformPackage(platform, cpu) {
  const key = `${platform}-${cpu}`;
  return SUPPORTED.includes(key) ? `@cntxt-labs/medha-${key}` : undefined;
}

function locate(platform, cpu, resolve) {
  const name = platformPackage(platform, cpu);
  const file = platform === 'win32' ? 'medha.exe' : 'medha';

  // 1. Try local dist folders (monorepo / checkout)
  const localCandidates = [
    path.resolve(__dirname, '..', '..', 'dist', 'medha', file),
    path.resolve(__dirname, '..', 'dist', file),
    path.resolve(__dirname, file),
  ];
  for (const candidate of localCandidates) {
    if (fs.existsSync(candidate)) {
      return { program: candidate };
    }
  }

  // 2. Try installed optional dependency package
  if (name !== undefined) {
    try {
      return { program: resolve(`${name}/bin/${file}`) };
    } catch (failure) {
      return {
        problem:
          `The ${name} package is not installed (${failure.code ?? failure.mesmedha}). ` +
          'It is an optional dependency of @cntxt-labs/medha: reinstall without --no-optional, or ' +
          `install ${name} directly.`,
      };
    }
  }

  return {
    problem:
      `medha binary not found for ${platform}-${cpu}. ` +
      `Run 'bun run build' in the medha repo to produce dist/medha/${file}, ` +
      `or install the platform package ${name ?? ''}.`,
  };
}

function main() {
  const found = locate(process.platform, process.arch, require.resolve);
  if (found.problem !== undefined) {
    process.stderr.write(`medha: ${found.problem}\n`);
    process.exitCode = 1;
    return;
  }
  const child = spawnSync(found.program, process.argv.slice(2), {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  if (child.error) {
    process.stderr.write(
      `medha: could not start ${path.basename(found.program)}: ${child.error.mesmedha}\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (child.signal) {
    process.kill(process.pid, child.signal);
    return;
  }
  process.exitCode = child.status ?? 1;
}

module.exports = { SUPPORTED, platformPackage, locate };

if (require.main === module) main();
