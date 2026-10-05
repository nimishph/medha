/**
 * `--write`: paths resolve for this platform (and fail loudly when an environment variable is
 * missing), and the medha entry merges into whatever the config file already holds — other
 * servers, other settings, or nothing at all.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { ConfigFileError, McpClientNotFoundError, McpRegistryError } from '../errors.ts';
import { loadRegistry } from './registry.ts';
import { displayPath, pickPath, resolvePath, writeClientConfig } from './write.ts';

const registry = loadRegistry();
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'medha-mcp-config-'));
  dirs.push(dir);
  return dir;
}

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (failure) {
    return failure;
  }
  return undefined;
}

describe('path handling', () => {
  it('picks the per-OS variant, falling back to default', () => {
    const spec = { darwin: '/a', windows: 'C:/b', default: '/c' };
    expect(pickPath(spec, 'darwin')).toBe('/a');
    expect(pickPath(spec, 'win32')).toBe('C:/b');
    expect(pickPath(spec, 'linux')).toBe('/c');
    expect(pickPath(spec, undefined)).toBe('/c');
    expect(pickPath('/plain', 'win32')).toBe('/plain');
  });

  it('labels every variant for display', () => {
    const label = displayPath({ darwin: '/a', windows: 'C:/b', default: '/c' });
    expect(label).toBe('/a (macOS) · C:/b (Windows) · /c (Linux/other)');
    expect(displayPath('.mcp.json')).toBe('.mcp.json');
  });

  it('expands ~ and environment variables, and anchors relative paths at cwd', () => {
    const home = join(tempDir(), 'home');
    const cwd = tempDir();
    expect(resolvePath('~/.cursor/mcp.json', { home })).toBe(join(home, '.cursor', 'mcp.json'));
    expect(
      resolvePath('%APPDATA%/Claude/claude_desktop_config.json', {
        home,
        platform: 'win32',
        env: { APPDATA: 'C:/Users/me/AppData/Roaming' },
      }),
    ).toBe(win32.normalize('C:/Users/me/AppData/Roaming/Claude/claude_desktop_config.json'));
    expect(resolvePath('.mcp.json', { cwd, home })).toBe(join(cwd, '.mcp.json'));
  });

  it('fails loudly when a variable the path needs is unset', () => {
    const failure = caught(() =>
      resolvePath('%APPDATA%/Claude/x.json', { platform: 'win32', env: {} }),
    );
    expect(failure).toBeInstanceOf(McpRegistryError);
    expect((failure as McpRegistryError).message).toContain('APPDATA');
  });
});

describe('writeClientConfig', () => {
  it('creates a missing file with the container, then reports no change on a second write', () => {
    const cwd = tempDir();
    const first = writeClientConfig(registry, 'cursor', { context: { cwd, home: cwd } });
    expect(first.path).toBe(join(cwd, '.cursor', 'mcp.json'));
    expect(first.created).toBe(true);
    expect(first.changed).toBe(true);
    const written = JSON.parse(readFileSync(first.path, 'utf8')) as Record<string, unknown>;
    expect(written).toEqual({
      mcpServers: { medha: { type: 'stdio', command: 'medha', args: ['mcp', 'serve'] } },
    });

    const second = writeClientConfig(registry, 'cursor', { context: { cwd, home: cwd } });
    expect(second.created).toBe(false);
    expect(second.changed).toBe(false);
  });

  it('merges beside an existing server and unrelated top-level settings', () => {
    const cwd = tempDir();
    const path = join(cwd, '.mcp.json');
    writeFileSync(
      path,
      `${JSON.stringify({ mcpServers: { other: { command: 'other' } }, theme: 'dark' }, null, 2)}\n`,
      'utf8',
    );
    writeClientConfig(registry, 'claude-code', { context: { cwd, home: cwd } });
    const merged = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(merged).toEqual({
      mcpServers: {
        other: { command: 'other' },
        medha: { command: 'medha', args: ['mcp', 'serve'] },
      },
      theme: 'dark',
    });
  });

  it('keeps github-copilot scopes in their own dialects', () => {
    const cwd = tempDir();
    writeClientConfig(registry, 'github-copilot', {
      scopeId: 'workspace',
      context: { cwd, home: cwd },
    });
    const workspace = JSON.parse(readFileSync(join(cwd, '.vscode', 'mcp.json'), 'utf8')) as {
      servers?: Record<string, unknown>;
    };
    expect(Object.keys(workspace.servers ?? {})).toEqual(['medha']);
  });

  it('writes the npx launcher when asked', () => {
    const cwd = tempDir();
    const result = writeClientConfig(registry, 'opencode', {
      launcherId: 'npx',
      context: { cwd, home: cwd },
    });
    const document = JSON.parse(readFileSync(result.path, 'utf8')) as {
      mcp?: { medha?: { command?: string[] } };
    };
    expect(document.mcp?.medha?.command?.[0]).toBe('npx');
  });

  it('reports an unknown client with the known ids', () => {
    const failure = caught(() =>
      writeClientConfig(registry, 'nope', { context: { cwd: tempDir() } }),
    );
    expect(failure).toBeInstanceOf(McpClientNotFoundError);
  });

  it('refuses a target file that is not a JSON object', () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, '.mcp.json'), '[]', 'utf8');
    const failure = caught(() =>
      writeClientConfig(registry, 'claude-code', { context: { cwd, home: cwd } }),
    );
    expect(failure).toBeInstanceOf(ConfigFileError);
    expect((failure as ConfigFileError).message).toContain('expected a JSON object');
  });

  it('reports a target file that does not parse as invalid JSON', () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, '.cursor'), { recursive: true });
    writeFileSync(join(cwd, '.cursor', 'mcp.json'), '{ nope', 'utf8');
    const failure = caught(() =>
      writeClientConfig(registry, 'cursor', { context: { cwd, home: cwd } }),
    );
    expect(failure).toBeInstanceOf(ConfigFileError);
    expect((failure as ConfigFileError).message).toContain('not valid JSON');
  });
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
