/**
 * Template rendering: each client's declarative dialect becomes the exact JSON it should, for
 * both launchers, across every scope. The table walks the whole registry, so a new clients.json
 * entry is covered the moment it lands; the cases below pin the dialects that differ.
 */

import { describe, expect, it } from 'bun:test';
import { McpRegistryError } from '../errors.ts';
import { VERSION } from '../version.ts';
import type { TemplateValue } from './registry.ts';
import { clientById, loadRegistry, scopeById } from './registry.ts';
import { renderAll, renderConfig, renderServerEntry, setAtPath, textOf } from './render.ts';

const registry = loadRegistry();

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (failure) {
    return failure;
  }
  return undefined;
}

describe('render across the registry', () => {
  it('renders every client × launcher × scope to parseable JSON with a command', () => {
    for (const client of registry.clients) {
      for (const launcherId of Object.keys(registry.launchers)) {
        for (const scope of client.scopes) {
          const rendered = renderConfig(registry, client, {
            launcherId,
            scopeId: scope.id,
          });
          expect(JSON.parse(rendered.text)).toEqual(rendered.document);
          expect(rendered.text.endsWith('\n')).toBe(true);
          const entry = rendered.document[rendered.container[0] as string] as Record<
            string,
            Record<string, unknown>
          >;
          const server = entry[rendered.serverName] as Record<string, unknown>;
          expect(server.command === undefined && server.url === undefined).toBe(false);
        }
      }
    }
  });

  it('covers exactly the registry clients in renderAll', () => {
    expect(renderAll(registry).map((r) => r.client.id)).toEqual(registry.clients.map((c) => c.id));
  });
});

describe('dialects', () => {
  it('claude-code: mcpServers with command/args, pinned for the npx launcher', () => {
    const claude = clientById(registry, 'claude-code');
    const path = renderConfig(registry, claude, { launcherId: 'path' });
    expect(path.document).toEqual({
      mcpServers: { medha: { command: 'medha', args: ['mcp', 'serve'] } },
    });
    const npx = renderConfig(registry, claude, { launcherId: 'npx' });
    expect(npx.document).toEqual({
      mcpServers: {
        medha: { command: 'npx', args: ['-y', `@cntxt-labs/medha-cli@${VERSION}`, 'mcp', 'serve'] },
      },
    });
  });

  it('cursor: adds type stdio', () => {
    const cursor = clientById(registry, 'cursor');
    const rendered = renderConfig(registry, cursor, {});
    expect(rendered.document).toEqual({
      mcpServers: { medha: { type: 'stdio', command: 'medha', args: ['mcp', 'serve'] } },
    });
  });

  it('github-copilot: `servers` in the workspace file, `mcpServers` in the user file', () => {
    const copilot = clientById(registry, 'github-copilot');
    const workspace = renderConfig(registry, copilot, { scopeId: 'workspace' });
    expect(workspace.document).toEqual({
      servers: { medha: { type: 'stdio', command: 'medha', args: ['mcp', 'serve'] } },
    });
    const user = renderConfig(registry, copilot, { scopeId: 'user' });
    expect(user.document).toEqual({
      mcpServers: { medha: { type: 'stdio', command: 'medha', args: ['mcp', 'serve'] } },
    });
  });

  it('opencode: mcp with a single command array and enabled true', () => {
    const opencode = clientById(registry, 'opencode');
    const rendered = renderConfig(registry, opencode, {});
    expect(rendered.document).toEqual({
      mcp: { medha: { type: 'local', command: ['medha', 'mcp', 'serve'], enabled: true } },
    });
  });

  it('claude-desktop: command/args, no transport type', () => {
    const desktop = clientById(registry, 'claude-desktop');
    const rendered = renderConfig(registry, desktop, {});
    expect(rendered.document).toEqual({
      mcpServers: { medha: { command: 'medha', args: ['mcp', 'serve'] } },
    });
  });

  it('a custom server name lands as the key', () => {
    const claude = clientById(registry, 'claude-code');
    const rendered = renderConfig(registry, claude, { serverName: 'evidence' });
    expect(rendered.document).toEqual({
      mcpServers: { evidence: { command: 'medha', args: ['mcp', 'serve'] } },
    });
  });
});

describe('template references', () => {
  it('omits $env when the launcher has none, and renders it when it does', () => {
    const template: Record<string, TemplateValue> = {
      command: '$argv[0]',
      args: '$argv[1:]',
      env: '$env',
    };
    const bare = renderServerEntry(template, {
      launcher: { label: 'x', argv: ['medha', 'mcp', 'serve'] },
      serverName: 'medha',
      where: 'custom',
    });
    expect(bare).toEqual({ command: 'medha', args: ['mcp', 'serve'] });

    const withEnv = renderServerEntry(template, {
      launcher: { label: 'x', argv: ['medha', 'mcp', 'serve'], env: { MEDHA_HOME: '/tmp/m' } },
      serverName: 'medha',
      where: 'custom',
    });
    expect(withEnv).toEqual({
      command: 'medha',
      args: ['mcp', 'serve'],
      env: { MEDHA_HOME: '/tmp/m' },
    });
  });

  it('substitutes the version placeholder wherever it appears', () => {
    const entry = renderServerEntry(
      { command: '$argv[0]', args: '$argv[1:]' },
      {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: placeholder text the renderer must substitute.
        launcher: { label: 'x', argv: ['npx', '-y', '@cntxt-labs/medha-cli@${version}'] },
        serverName: 'medha',
        where: 'custom',
      },
    );
    expect(entry.args).toEqual(['-y', `@cntxt-labs/medha-cli@${VERSION}`]);
  });

  it('supports $argv[i], $argv[i:] and $argv[i:j]', () => {
    const launcher = { label: 'x', argv: ['a', 'b', 'c', 'd'] };
    const at = (template: Record<string, TemplateValue>): Record<string, unknown> =>
      renderServerEntry(template, { launcher, serverName: 'medha', where: 'custom' });
    expect(at({ command: '$argv[0]' }).command).toBe('a');
    expect(at({ command: '$argv[0]', args: '$argv[1:]' }).args).toEqual(['b', 'c', 'd']);
    expect(at({ command: '$argv[0]', args: '$argv[1:3]' }).args).toEqual(['b', 'c']);
    expect(at({ command: '$argv', args: '$serverName' }).command).toEqual(['a', 'b', 'c', 'd']);
    expect(at({ command: '$argv[0]', args: '$serverName' }).args).toBe('medha');
  });

  it('rejects an unknown reference, naming the client', () => {
    const failure = caught(() =>
      renderServerEntry(
        { command: '$commandPath' },
        { launcher: { label: 'x', argv: ['medha'] }, serverName: 'medha', where: 'custom' },
      ),
    );
    expect(failure).toBeInstanceOf(McpRegistryError);
    expect((failure as McpRegistryError).message).toContain("client 'custom'");
    expect((failure as McpRegistryError).message).toContain('$commandPath');
  });

  it('rejects an out-of-range argv index', () => {
    const failure = caught(() =>
      renderServerEntry(
        { command: '$argv[9]' },
        { launcher: { label: 'x', argv: ['medha'] }, serverName: 'medha', where: 'custom' },
      ),
    );
    expect(failure).toBeInstanceOf(McpRegistryError);
    expect((failure as McpRegistryError).message).toContain('out of range');
  });
});

describe('setAtPath', () => {
  it('sets the leaf and keeps sibling keys at every level', () => {
    const document: Record<string, unknown> = { other: 1, mcpServers: { existing: { a: 1 } } };
    setAtPath(document, ['mcpServers', 'medha'], { command: 'medha' });
    expect(document).toEqual({
      other: 1,
      mcpServers: { existing: { a: 1 }, medha: { command: 'medha' } },
    });
  });

  it('creates the whole container when it is missing', () => {
    const document: Record<string, unknown> = {};
    setAtPath(document, ['mcpServers', 'medha'], { command: 'medha' });
    expect(document).toEqual({ mcpServers: { medha: { command: 'medha' } } });
  });

  it('creates intermediate containers for a deep path', () => {
    const document: Record<string, unknown> = {};
    setAtPath(document, ['mcp', 'servers', 'medha'], { command: 'medha' });
    expect(document).toEqual({ mcp: { servers: { medha: { command: 'medha' } } } });
  });

  it('refuses to merge through a non-object', () => {
    const document: Record<string, unknown> = { mcpServers: 'broken' };
    const failure = caught(() => setAtPath(document, ['mcpServers', 'medha'], { command: 'x' }));
    expect(failure).toBeInstanceOf(McpRegistryError);
    expect((failure as McpRegistryError).message).toContain('not a JSON object');
  });

  it('textOf round-trips', () => {
    const document = { mcpServers: { medha: { command: 'medha' } } };
    expect(JSON.parse(textOf(document))).toEqual(document);
    expect(textOf(document).endsWith('\n')).toBe(true);
  });
});

describe('scope resolution', () => {
  it('renders the default scope when none is asked for', () => {
    const cursor = clientById(registry, 'cursor');
    const byDefault = renderConfig(registry, cursor, {});
    const byId = renderConfig(registry, cursor, { scopeId: scopeById(cursor, undefined).id });
    expect(byDefault.scope.id).toBe('project');
    expect(byDefault.document).toEqual(byId.document);
  });
});
