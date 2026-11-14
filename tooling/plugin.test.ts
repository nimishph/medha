/**
 * Freshness gate for the Claude Code plugin: the files `tooling/sync-plugin.ts` derives from
 * canonical sources must be on disk exactly as that tool would write them, and the hand-written
 * files must keep the invariants `claude plugin validate` cannot check from here (every command
 * declares a description, the repo root stays out of the plugin/marketplace business).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildPluginFiles } from './sync-plugin.ts';

const root = fileURLToPath(new URL('../', import.meta.url));

function read(path: string): string {
  return readFileSync(`${root}${path}`, 'utf8');
}

function readJson(path: string): unknown {
  return JSON.parse(read(path)) as unknown;
}

function frontmatterBody(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
}

describe('Claude Code plugin freshness', () => {
  test('generated files on disk match their canonical sources byte for byte', async () => {
    const stale: string[] = [];
    for (const [path, content] of await buildPluginFiles()) {
      let onDisk: string | undefined;
      try {
        onDisk = read(path);
      } catch {
        onDisk = undefined;
      }
      if (onDisk !== content) stale.push(path);
    }
    expect(stale).toEqual([]);
  });

  test('the plugin skill is the root skill body verbatim, renamed for the plugin prefix', () => {
    const skill = read('plugin/skills/agent/SKILL.md');
    const rootSkill = read('SKILL.md');
    expect(frontmatterBody(skill)).toBe(frontmatterBody(rootSkill));
    expect(skill.startsWith('---\nname: agent\n')).toBe(true);
    const description = rootSkill.match(/^description: .*$/m)?.[0];
    expect(description).toBeDefined();
    expect(skill).toContain(description ?? 'missing-description');
  });

  test('the bundled MCP server is the registry npx launcher pinned to the current CLI version', () => {
    const servers = (readJson('plugin/.mcp.json') as { mcpServers?: Record<string, unknown> })
      .mcpServers;
    const entry = servers?.medha as { command?: string; args?: string[] } | undefined;
    expect(entry?.command).toBe('npx');
    expect(entry?.args?.slice(-2)).toEqual(['mcp', 'serve']);
    const version = (readJson('cli/package.json') as { version: string }).version;
    expect(entry?.args).toContain(`@cntxt-labs/medha-cli@${version}`);
  });

  test('the manifest keeps the plugin name and tracks the CLI package version', () => {
    const manifest = readJson('plugin/.claude-plugin/plugin.json') as {
      name?: string;
      version?: string;
      description?: string;
    };
    expect(manifest.name).toBe('medha');
    expect(manifest.version).toBe((readJson('cli/package.json') as { version: string }).version);
    expect(typeof manifest.description).toBe('string');
  });

  test('the repo root hosts no plugin and no marketplace of its own', () => {
    // Distribution lives in the `nimishph/cntxt-labs` marketplace, and local alpha/beta installs
    // in the `cntxt-labs-dev` workspace marketplace. A root marketplace here would compete with
    // the org one for the `cntxt-labs` name; a root plugin.json would claim both roles at once.
    expect(existsSync(`${root}.claude-plugin/marketplace.json`)).toBe(false);
    expect(existsSync(`${root}.claude-plugin/plugin.json`)).toBe(false);
    expect(existsSync(`${root}plugin/.claude-plugin/plugin.json`)).toBe(true);
  });

  test('every command file declares a frontmatter description', () => {
    const commands = ['status', 'hints', 'drift', 'pack', 'propose', 'why'];
    for (const name of commands) {
      const text = read(`plugin/commands/${name}.md`);
      expect(text).toMatch(/^---\ndescription: .+\n---\n/);
    }
  });

  test('SKILL.md commands and MCP tools exist in the CLI and MCP server (medha-wt5.1)', async () => {
    const rootSkill = read('SKILL.md');
    const { COMMAND_GROUPS } = await import('../cli/src/groups.ts');
    const knownCommands = new Set(COMMAND_GROUPS.flatMap((g) => g.commands));

    // Every CLI command named in SKILL.md as `medha <cmd>` must exist in COMMAND_GROUPS
    const cliMatches = Array.from(rootSkill.matchAll(/`medha ([a-z0-9-]+)(?: [^`]+)?`/g));
    const extractedCommands = new Set(
      cliMatches.map((m) => m[1]).filter((c): c is string => typeof c === 'string'),
    );
    for (const cmd of extractedCommands) {
      expect(knownCommands.has(cmd)).toBe(true);
    }

    // Every MCP tool named in SKILL.md must exist in cli/src/mcp.ts
    const mcpSource = read('cli/src/mcp.ts');
    const mcpTools = new Set(
      Array.from(mcpSource.matchAll(/server\.(?:registerTool|tool)\(\s*['"]([a-z_]+)['"]/g)).map(
        (m) => m[1],
      ),
    );
    const expectedSkillTools = [
      'hints',
      'record_signal',
      'report_guard',
      'record_decision',
      'propose',
      'show_entity',
      'simulate',
      'retract_episode',
      'primer',
    ];
    for (const tool of expectedSkillTools) {
      expect(mcpTools.has(tool)).toBe(true);
    }

    // Verify site/agent-skill.md (if generated) contains the core text of SKILL.md
    if (existsSync(`${root}site/agent-skill.md`)) {
      const siteSkill = read('site/agent-skill.md');
      expect(siteSkill).toContain('Mental Model: Dual-Loop Architecture');
      expect(siteSkill).toContain('Per-kind policy (kindSpecs)');
    }
  });

  test('hooks manifest and scripts exist with valid structure (medha-wt5.2, medha-wt5.3, medha-wt5.4)', () => {
    expect(existsSync(`${root}plugin/hooks/hooks.json`)).toBe(true);
    expect(existsSync(`${root}plugin/scripts/session-start.cjs`)).toBe(true);
    expect(existsSync(`${root}plugin/scripts/post-tool-use.cjs`)).toBe(true);
    expect(existsSync(`${root}plugin/scripts/run-cli.cjs`)).toBe(true);

    const hooks = readJson('plugin/hooks/hooks.json') as {
      hooks?: {
        SessionStart?: Array<{ hooks?: Array<{ command?: string }> }>;
        PostToolUse?: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;
      };
    };
    expect(hooks.hooks?.SessionStart?.[0]?.hooks?.[0]?.command).toContain('session-start.cjs');
    expect(hooks.hooks?.PostToolUse?.[0]?.matcher).toBe('Bash');
    expect(hooks.hooks?.PostToolUse?.[0]?.hooks?.[0]?.command).toContain('post-tool-use.cjs');
  });

  test('SessionStart hook exits silently when .medha/ is missing (medha-wt5.3)', () => {
    const { spawnSync } = require('node:child_process');
    const script = `${root}plugin/scripts/session-start.cjs`;
    const res = spawnSync(process.execPath, [script], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: `${root}node_modules` },
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
  });

  test('PostToolUse hook parses guard mappings and matches commands correctly (medha-wt5.4)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { parseGuardMappings, normalizeCommand } =
      require('../plugin/scripts/post-tool-use.cjs') as {
        parseGuardMappings: (config: Record<string, unknown>) => Array<{
          command: string;
          guard: string;
          entities: string[];
        }>;
        normalizeCommand: (cmd: string) => string;
      };
    expect(normalizeCommand('  bun   test   ')).toBe('bun test');

    const config = {
      guards: [{ command: 'bun test', guard: 'test', entities: ['rule:my-rule'] }],
      commandGuards: {
        'bun run lint': { guard: 'lint', entities: ['rule:lint-rule'] },
      },
    };
    const mappings = parseGuardMappings(config);
    expect(mappings).toHaveLength(2);
    expect(mappings[0]).toEqual({
      command: 'bun test',
      guard: 'test',
      entities: ['rule:my-rule'],
    });
    expect(mappings[1]).toEqual({
      command: 'bun run lint',
      guard: 'lint',
      entities: ['rule:lint-rule'],
    });
  });
});
