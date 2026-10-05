/**
 * The declarative MCP client registry: the bundled file parses and passes every cross-check, the
 * JSON Schema beside it stays in sync, and the errors a bad registry or a typo'd id produce name
 * what to fix. Adding a client is a clients.json edit — these tests guard that edit.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { McpClientNotFoundError, McpRegistryError } from '../errors.ts';
import type { McpRegistry } from './registry.ts';
import {
  clientById,
  launcherById,
  loadRegistry,
  parseRegistry,
  registryClientIds,
  scopeById,
} from './registry.ts';

const rootDir = resolve(import.meta.dir, '../../..');

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (failure) {
    return failure;
  }
  return undefined;
}

const coreFive = ['claude-code', 'cursor', 'github-copilot', 'opencode', 'claude-desktop'];

describe('bundled registry (clients.json)', () => {
  it('parses with the core five clients, in declaration order', () => {
    const registry = loadRegistry();
    expect(registryClientIds(registry)).toEqual(coreFive);
    expect(registry.serverName).toBe('medha');
  });

  it('carries a path and a pinned npx launcher, both ending in `mcp serve`', () => {
    const registry = loadRegistry();
    expect(registry.launchers.path?.argv).toEqual(['medha', 'mcp', 'serve']);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the registry carries ${version} as literal placeholder text.
    const pinned = ['npx', '-y', '@cntxt-labs/medha-cli@${version}', 'mcp', 'serve'];
    expect(registry.launchers.npx?.argv).toEqual(pinned);
    expect(registry.launchers.npx?.label).toBe('npx (pinned)');
  });

  it('gives every client a default scope, https docs, and a command template', () => {
    const registry = loadRegistry();
    for (const client of registry.clients) {
      expect(client.docs.startsWith('https://')).toBe(true);
      expect(client.scopes.filter((scope) => scope.default === true)).toHaveLength(1);
      expect(client.document.format).toBe('json');
      expect(Object.keys(client.document.template)).toContain('command');
    }
  });

  it('keeps the two keys of github-copilot apart: workspace `servers`, user `mcpServers`', () => {
    const registry = loadRegistry();
    const copilot = clientById(registry, 'github-copilot');
    expect(copilot.document.container).toEqual(['servers']);
    const user = scopeById(copilot, 'user');
    expect(user.container).toEqual(['mcpServers']);
  });

  it('declares per-OS config paths for claude-desktop', () => {
    const registry = loadRegistry();
    const desktop = clientById(registry, 'claude-desktop');
    const app = scopeById(desktop, 'app');
    const spec = typeof app.path === 'string' ? undefined : app.path;
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expect(spec.darwin).toContain('Library/Application Support/Claude');
    expect(spec.windows).toContain('%APPDATA%');
    expect(spec.default).toContain('.config/Claude');
  });
});

describe('mcp-clients.v1.json schema', () => {
  it('exists as JSON Schema draft 2020-12 and is what clients.json points at', () => {
    const schemaPath = join(rootDir, 'schemas', 'mcp-clients.v1.json');
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toBe(
      'https://raw.githubusercontent.com/nimishph/medha/main/schemas/mcp-clients.v1.json',
    );

    const clientsPath = join(rootDir, 'cli', 'src', 'integrations', 'clients.json');
    const clients = JSON.parse(readFileSync(clientsPath, 'utf8')) as { $schema?: string };
    expect(clients.$schema).toBe('../../../schemas/mcp-clients.v1.json');
  });
});

describe('parseRegistry cross-checks', () => {
  const base = (): Record<string, unknown> => ({
    serverName: 'medha',
    launchers: { path: { label: 'on PATH', argv: ['medha', 'mcp', 'serve'] } },
    clients: [
      {
        id: 'one',
        name: 'One',
        docs: 'https://example.com/one',
        scopes: [{ id: 'project', label: 'Project', path: '.one.json', default: true }],
        document: { format: 'json', container: ['mcpServers'], template: { command: '$argv[0]' } },
      },
    ],
  });

  it('accepts a minimal well-formed registry', () => {
    const registry = parseRegistry(base());
    expect(registry.clients).toHaveLength(1);
  });

  it('rejects a schema violation, naming the offending path', () => {
    const bad = base();
    (bad as { clients: unknown[] }).clients = [];
    const failure = caught(() => parseRegistry(bad));
    expect(failure).toBeInstanceOf(McpRegistryError);
    expect((failure as McpRegistryError).message).toContain('clients');
  });

  it('rejects duplicate client ids', () => {
    const bad = base();
    const clients = bad.clients as Record<string, unknown>[];
    clients.push({ ...clients[0] });
    expect(caught(() => parseRegistry(bad))).toBeInstanceOf(McpRegistryError);
  });

  it('rejects two default scopes on one client', () => {
    const bad = base();
    const clients = bad.clients as { scopes: Record<string, unknown>[] }[];
    clients[0]?.scopes.push({ id: 'user', label: 'User', path: '~/.one.json', default: true });
    const failure = caught(() => parseRegistry(bad));
    expect(failure).toBeInstanceOf(McpRegistryError);
    expect((failure as McpRegistryError).message).toContain('at most one');
  });

  it('rejects a template without a command', () => {
    const bad = base();
    const clients = bad.clients as { document: { template: Record<string, unknown> } }[];
    const template = clients[0]?.document.template;
    if (template !== undefined) delete template.command;
    const failure = caught(() => parseRegistry(bad));
    expect(failure).toBeInstanceOf(McpRegistryError);
    expect((failure as McpRegistryError).message).toContain('command');
  });
});

describe('lookups', () => {
  const registry: McpRegistry = loadRegistry();

  it('reports an unknown client with the known ids as a hint', () => {
    const failure = caught(() => clientById(registry, 'cursorr'));
    expect(failure).toBeInstanceOf(McpClientNotFoundError);
    expect((failure as McpClientNotFoundError).hint).toContain('claude-code');
  });

  it('reports an unknown launcher with the known launchers', () => {
    const failure = caught(() => launcherById(registry, 'bunx'));
    expect(failure).toBeInstanceOf(McpRegistryError);
    expect((failure as McpRegistryError).hint).toContain('path');
  });

  it('defaults the scope to the client default, and reports unknown scopes', () => {
    const cursor = clientById(registry, 'cursor');
    expect(scopeById(cursor, undefined).id).toBe('project');
    expect(scopeById(cursor, 'user').id).toBe('user');
    const failure = caught(() => scopeById(cursor, 'team'));
    expect(failure).toBeInstanceOf(McpRegistryError);
    expect((failure as McpRegistryError).hint).toContain('project, user');
  });
});
