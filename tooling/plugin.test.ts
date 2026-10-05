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
    const commands = ['status', 'hints', 'drift', 'pack'];
    for (const name of commands) {
      const text = read(`plugin/commands/${name}.md`);
      expect(text).toMatch(/^---\ndescription: .+\n---\n/);
    }
  });
});
