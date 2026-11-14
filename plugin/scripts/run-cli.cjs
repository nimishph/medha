#!/usr/bin/env node
'use strict';
/**
 * Cross-platform runner for the medha CLI used by plugin hooks and commands.
 * Resolves medha from:
 * 1. MEDHA_BIN environment variable
 * 2. MEDHA_BINARY_PATH environment variable
 * 3. Local repository checkout binaries (target/debug, target/release, or cli/bin/medha.cjs)
 * 4. System PATH (medha, medha.exe, medha.cmd)
 * 5. npx launcher fallback
 */

const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync, statSync } = require('node:fs');
const path = require('node:path');

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function resolvePluginVersion(pluginRoot) {
  try {
    const pkgPath = path.join(pluginRoot, '..', 'cli', 'package.json');
    if (existsSync(pkgPath)) {
      return JSON.parse(readFileSync(pkgPath, 'utf8')).version;
    }
  } catch {}
  return 'latest';
}

function findMedha(env = process.env, platform = process.platform) {
  if (env.MEDHA_BIN && isFile(env.MEDHA_BIN)) {
    return { command: env.MEDHA_BIN, args: [] };
  }
  if (env.MEDHA_BINARY_PATH && isFile(env.MEDHA_BINARY_PATH)) {
    return { command: env.MEDHA_BINARY_PATH, args: [] };
  }

  const pluginRoot = path.resolve(__dirname, '..');
  const repoRoot = path.resolve(pluginRoot, '..');

  // Check repo compiled binaries if present
  const debugExe = path.join(repoRoot, 'target', 'debug', platform === 'win32' ? 'medha.exe' : 'medha');
  if (isFile(debugExe)) {
    return { command: debugExe, args: [] };
  }
  const releaseExe = path.join(repoRoot, 'target', 'release', platform === 'win32' ? 'medha.exe' : 'medha');
  if (isFile(releaseExe)) {
    return { command: releaseExe, args: [] };
  }

  // Check repo JS/TS entrypoints
  const repoCliCjs = path.join(repoRoot, 'cli', 'bin', 'medha.cjs');
  if (isFile(repoCliCjs)) {
    return { command: process.execPath, args: [repoCliCjs] };
  }

  // Check system PATH
  const pathDirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    if (platform === 'win32') {
      const exe = path.join(dir, 'medha.exe');
      if (isFile(exe)) return { command: exe, args: [] };
      const cmd = path.join(dir, 'medha.cmd');
      if (isFile(cmd)) return { command: cmd, args: [], isCmd: true };
    } else {
      const bin = path.join(dir, 'medha');
      if (isFile(bin)) return { command: bin, args: [] };
    }
  }

  // Fallback to npx
  const ver = resolvePluginVersion(pluginRoot);
  return {
    command: platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['-y', `@cntxt-labs/medha-cli@${ver}`],
    isCmd: platform === 'win32',
  };
}

function runMedha(cliArgs, options = {}) {
  const { command, args: prefixArgs, isCmd } = findMedha(options.env);
  const fullArgs = [...prefixArgs, ...cliArgs];
  return spawnSync(command, fullArgs, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    encoding: 'utf8',
    shell: isCmd ? true : false,
    timeout: options.timeout || 15000,
  });
}

module.exports = {
  findMedha,
  runMedha,
};
