#!/usr/bin/env node
'use strict';
/**
 * SessionStart hook for the medha Claude Code plugin (medha-wt5.3).
 *
 * Fast inner loop, automated:
 * - Checks for .medha/ in the project directory.
 * - If absent, exits silently and immediately (negligible startup latency).
 * - If present, queries trusted and active entity hints within a token budget.
 * - Emits a concise trust hint block, reminding the agent that medha reports evidence and never decides.
 */

const { existsSync } = require('node:fs');
const path = require('node:path');
const { runMedha } = require('./run-cli.cjs');

function main() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const medhaDir = path.join(projectDir, '.medha');

  // Fast pre-flight check: no-op silently if .medha/ is absent
  if (!existsSync(medhaDir)) {
    process.exit(0);
  }

  const hasStore =
    existsSync(path.join(medhaDir, 'store.sqlite')) ||
    existsSync(path.join(medhaDir, 'config.json'));
  if (!hasStore) {
    process.exit(0);
  }

  try {
    // Pack trusted/active entities (budget: 1500 tokens, exploration: 0 to exclude probation)
    const result = runMedha(
      ['pack', '--dir', projectDir, '--budget', '1500', '--exploration', '0', '--format', 'compact'],
      { cwd: projectDir, timeout: 5000 },
    );

    if (result.status === 0 && result.stdout) {
      const output = result.stdout.trim();
      // Only emit if entities were selected
      if (output.includes('KEY') || output.includes('trusted') || output.includes('active')) {
        process.stdout.write(
          `[medha] Evidential memory active (${projectDir})\n` +
          `Trusted & active rule hints:\n` +
          `${output}\n` +
          `Note: Medha reports calibrated evidence; the agent and human decide actions.\n`,
        );
      }
    }
  } catch {
    // Graceful silent fallback on any exception
  }

  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { main };
