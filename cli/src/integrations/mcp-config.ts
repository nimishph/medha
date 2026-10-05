import type { McpRegistry } from './registry.ts';
import { clientById, loadRegistry } from './registry.ts';
import type { RenderedConfig, RenderOptions } from './render.ts';
import { renderConfig } from './render.ts';
import type { WriteOptions } from './write.ts';
import { displayPath, writeClientConfig } from './write.ts';

/**
 * The `medha mcp config` report shapes and the run functions behind them. Everything here is
 * derived from the declarative registry; the human renderers live in the CLI's render.ts.
 */

export interface McpConfigClientRow {
  readonly id: string;
  readonly name: string;
  readonly docs: string;
  readonly notes?: string | undefined;
  readonly scopes: readonly {
    readonly id: string;
    readonly label: string;
    readonly path: string;
  }[];
}

export interface McpConfigListReport {
  readonly clients: readonly McpConfigClientRow[];
  readonly launchers: readonly { readonly id: string; readonly label: string }[];
}

export interface McpConfigSnippetReport {
  readonly clientId: string;
  readonly clientName: string;
  readonly docs: string;
  readonly notes?: string | undefined;
  readonly scopeId: string;
  readonly scopeLabel: string;
  /** The path as the registry declares it (per-OS variants labelled), not resolved for this box. */
  readonly path: string;
  readonly launcherId: string;
  readonly launcherLabel: string;
  readonly serverName: string;
  readonly document: Record<string, unknown>;
  readonly text: string;
}

export interface McpConfigWriteReport {
  readonly clientId: string;
  readonly clientName: string;
  readonly scopeId: string;
  readonly launcherId: string;
  readonly serverName: string;
  readonly path: string;
  readonly created: boolean;
  readonly changed: boolean;
}

export function runMcpConfigList(registry: McpRegistry = loadRegistry()): McpConfigListReport {
  return {
    clients: registry.clients.map((client) => ({
      id: client.id,
      name: client.name,
      docs: client.docs,
      ...(client.notes === undefined ? {} : { notes: client.notes }),
      scopes: client.scopes.map((scope) => ({
        id: scope.id,
        label: scope.label,
        path: displayPath(scope.path),
      })),
    })),
    launchers: Object.entries(registry.launchers).map(([id, launcher]) => ({
      id,
      label: launcher.label,
    })),
  };
}

export function runMcpConfigSnippet(
  registry: McpRegistry,
  clientId: string,
  options: RenderOptions = {},
): McpConfigSnippetReport {
  const rendered = renderConfig(registry, clientById(registry, clientId), options);
  return toSnippetReport(rendered);
}

/** Every client's snippet (default scope), for `--all` and the generated docs page. */
export function runMcpConfigAll(
  registry: McpRegistry = loadRegistry(),
  options: RenderOptions = {},
): McpConfigSnippetReport[] {
  return registry.clients.map((client) => toSnippetReport(renderConfig(registry, client, options)));
}

export function runMcpConfigWrite(
  registry: McpRegistry,
  clientId: string,
  options: WriteOptions = {},
): McpConfigWriteReport {
  const result = writeClientConfig(registry, clientId, options);
  const { rendered } = result;
  return {
    clientId: rendered.client.id,
    clientName: rendered.client.name,
    scopeId: rendered.scope.id,
    launcherId: rendered.launcherId,
    serverName: rendered.serverName,
    path: result.path,
    created: result.created,
    changed: result.changed,
  };
}

function toSnippetReport(rendered: RenderedConfig): McpConfigSnippetReport {
  return {
    clientId: rendered.client.id,
    clientName: rendered.client.name,
    docs: rendered.client.docs,
    ...(rendered.client.notes === undefined ? {} : { notes: rendered.client.notes }),
    scopeId: rendered.scope.id,
    scopeLabel: rendered.scope.label,
    path: displayPath(rendered.scope.path),
    launcherId: rendered.launcherId,
    launcherLabel: rendered.launcher.label,
    serverName: rendered.serverName,
    document: rendered.document,
    text: rendered.text,
  };
}
