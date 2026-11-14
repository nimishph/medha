#!/usr/bin/env node
'use strict';
/**
 * PostToolUse hook for the medha Claude Code plugin (medha-wt5.4).
 *
 * Slow outer loop, automated:
 * - Detects Bash command execution.
 * - Inspects .medha/config.json for guard command mappings (e.g. test, lint, typecheck).
 * - On match, evaluates command outcome (exit code 0 = ok, non-zero = fail).
 * - Conservative: ignores ambiguous outcomes and dedupes repeated runs.
 * - Records guard results for covered entities via `medha guard`.
 */

const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { runMedha } = require('./run-cli.cjs');

const DEDUPE_WINDOW_MS = 3000;

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function normalizeCommand(cmd) {
  return (cmd || '').trim().replace(/\s+/g, ' ');
}

function parseGuardMappings(config) {
  const mappings = [];

  // Format 1: config.guards = [ { command: "bun test", guard: "test", entities: ["rule:my-rule"] } ]
  if (Array.isArray(config.guards)) {
    for (const g of config.guards) {
      if (g && typeof g.command === 'string' && typeof g.guard === 'string' && Array.isArray(g.entities)) {
        mappings.push({
          command: normalizeCommand(g.command),
          guard: g.guard,
          entities: g.entities,
        });
      }
    }
  }

  // Format 2: config.commandGuards = { "bun test": { guard: "test", entities: ["rule:my-rule"] } }
  if (config.commandGuards && typeof config.commandGuards === 'object') {
    for (const [cmd, spec] of Object.entries(config.commandGuards)) {
      if (spec && typeof spec.guard === 'string' && Array.isArray(spec.entities)) {
        mappings.push({
          command: normalizeCommand(cmd),
          guard: spec.guard,
          entities: spec.entities,
        });
      }
    }
  }

  return mappings;
}

function checkDedupe(key, now) {
  const cachePath = path.join(tmpdir(), 'medha-guard-dedupe.json');
  let cache = {};
  try {
    if (existsSync(cachePath)) {
      cache = JSON.parse(readFileSync(cachePath, 'utf8'));
    }
  } catch {}

  const lastTime = cache[key] || 0;
  if (now - lastTime < DEDUPE_WINDOW_MS) {
    return true; // Already recorded recently
  }

  cache[key] = now;
  try {
    writeFileSync(cachePath, JSON.stringify(cache));
  } catch {}
  return false;
}

function main() {
  const rawInput = readStdin();
  if (!rawInput.trim()) {
    process.exit(0);
  }

  let payload;
  try {
    payload = JSON.parse(rawInput);
  } catch {
    process.exit(0);
  }

  // Check tool name: handle 'Bash', 'bash', or tool_name field
  const toolName = payload.tool_name || payload.toolName || payload.name;
  if (typeof toolName !== 'string' || toolName.toLowerCase() !== 'bash') {
    process.exit(0);
  }

  const toolInput = payload.tool_input || payload.input || {};
  const executedCommand = normalizeCommand(toolInput.command);
  if (!executedCommand) {
    process.exit(0);
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const configPath = path.join(projectDir, '.medha', 'config.json');
  if (!existsSync(configPath)) {
    process.exit(0);
  }

  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    process.exit(0);
  }

  const mappings = parseGuardMappings(config);
  if (mappings.length === 0) {
    process.exit(0);
  }

  // Find matching mapping
  const match = mappings.find(
    (m) => executedCommand === m.command || executedCommand.startsWith(`${m.command} `),
  );
  if (!match) {
    process.exit(0);
  }

  // Determine exit code and outcome
  const response = payload.tool_response || payload.response || {};
  const exitCode = response.exit_code ?? response.exitCode ?? response.code;

  if (typeof exitCode !== 'number') {
    // Ambiguous outcome (e.g. interrupted or unparseable), do not record
    process.exit(0);
  }

  const ok = exitCode === 0;
  const now = Date.now();
  const dedupeKey = `${projectDir}:${match.command}:${ok ? '1' : '0'}`;
  if (checkDedupe(dedupeKey, now)) {
    process.exit(0);
  }

  // Record guard result for each covered entity
  for (const entity of match.entities) {
    let kind = 'rule';
    let id = entity;
    if (typeof entity === 'string' && entity.includes(':')) {
      const parts = entity.split(':');
      kind = parts[0];
      id = parts.slice(1).join(':');
    }

    const guardArgs = [
      'guard',
      '--dir',
      projectDir,
      '--kind',
      kind,
      '--id',
      id,
      '--guard',
      match.guard,
      ok ? '--ok' : '--fail',
    ];

    try {
      const res = runMedha(guardArgs, { cwd: projectDir });
      if (res.status === 0) {
        process.stdout.write(
          `[medha] Auto-recorded guard '${match.guard}' (${ok ? 'PASS' : 'FAIL'}) for ${kind}:${id}\n`,
        );
      }
    } catch {}
  }

  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  parseGuardMappings,
  normalizeCommand,
};
