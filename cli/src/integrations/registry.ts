import { z } from 'zod';
import { McpClientNotFoundError, McpRegistryError } from '../errors.ts';
import registryJson from './clients.json' with { type: 'json' };

/**
 * The declarative MCP client registry: every supported AI coding tool, where its config file
 * lives, and how the medha server entry renders into that file's dialect — all as data
 * (`clients.json`), validated here and interpreted by render.ts / write.ts. Adding a client is a
 * JSON edit, not a code change.
 */

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/** A template value: a reference or literal string, a literal scalar, or a nested structure. */
export type TemplateValue =
  | string
  | number
  | boolean
  | TemplateValue[]
  | { [key: string]: TemplateValue };

const templateSchema: z.ZodType<TemplateValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(templateSchema),
    z.record(z.string(), templateSchema),
  ]),
);

const pathSpecSchema = z.union([
  z.string().min(1),
  z
    .object({
      windows: z.string().min(1).optional(),
      darwin: z.string().min(1).optional(),
      linux: z.string().min(1).optional(),
      default: z.string().min(1),
    })
    .strict(),
]);

const launcherSchema = z
  .object({
    label: z.string().min(1),
    argv: z.array(z.string()).min(1),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const scopeSchema = z
  .object({
    id: z.string().regex(ID_PATTERN),
    label: z.string().min(1),
    path: pathSpecSchema,
    default: z.boolean().optional(),
    container: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

const documentSchema = z
  .object({
    format: z.literal('json'),
    container: z.array(z.string().min(1)).min(1),
    template: z.record(z.string(), templateSchema),
  })
  .strict();

const clientSchema = z
  .object({
    id: z.string().regex(ID_PATTERN),
    name: z.string().min(1),
    docs: z.url(),
    notes: z.string().optional(),
    scopes: z.array(scopeSchema).min(1),
    document: documentSchema,
  })
  .strict();

const registrySchema = z
  .object({
    $schema: z.string().optional(),
    serverName: z.string().min(1),
    launchers: z.record(z.string(), launcherSchema),
    clients: z.array(clientSchema).min(1),
  })
  .strict();

export type PathSpec = z.infer<typeof pathSpecSchema>;
export type Launcher = z.infer<typeof launcherSchema>;
export type ClientScope = z.infer<typeof scopeSchema>;
export type ClientDocument = z.infer<typeof documentSchema>;
export type McpClient = z.infer<typeof clientSchema>;
export type McpRegistry = z.infer<typeof registrySchema>;

/**
 * Parse and cross-check a registry: shape first (zod), then the rules a schema cannot express —
 * unique client ids, one default scope per client, and a non-empty launcher table.
 */
export function parseRegistry(raw: unknown): McpRegistry {
  const parsed = registrySchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length === 0 ? '(root)' : (first?.path.join('.') ?? '(root)');
    throw new McpRegistryError(`${where}: ${first?.message ?? 'invalid structure'}`, {
      hint: 'cli/src/integrations/clients.json must satisfy schemas/mcp-clients.v1.json',
      cause: parsed.error,
    });
  }
  const registry = parsed.data;
  if (Object.keys(registry.launchers).length === 0) {
    throw new McpRegistryError('launchers is empty', {
      hint: 'at least the "path" launcher (medha on PATH) must be defined',
    });
  }
  const seen = new Set<string>();
  for (const client of registry.clients) {
    if (seen.has(client.id)) {
      throw new McpRegistryError(`duplicate client id '${client.id}'`);
    }
    seen.add(client.id);
    const scopeIds = new Set<string>();
    let defaults = 0;
    for (const scope of client.scopes) {
      if (scopeIds.has(scope.id)) {
        throw new McpRegistryError(`client '${client.id}' has duplicate scope id '${scope.id}'`);
      }
      scopeIds.add(scope.id);
      if (scope.default === true) defaults += 1;
    }
    if (defaults > 1) {
      throw new McpRegistryError(
        `client '${client.id}' marks ${defaults} scopes as default; at most one may be`,
      );
    }
    const template = client.document.template;
    if (template.command === undefined && template.url === undefined) {
      throw new McpRegistryError(
        `client '${client.id}' template declares neither 'command' nor 'url'`,
        { hint: 'every client must render a launchable server entry' },
      );
    }
  }
  return registry;
}

/** The registry bundled with the program. */
export function loadRegistry(): McpRegistry {
  return parseRegistry(registryJson);
}

export function registryClientIds(registry: McpRegistry): string[] {
  return registry.clients.map((client) => client.id);
}

/** A client by id, or an error naming the ids the registry does carry. */
export function clientById(registry: McpRegistry, id: string): McpClient {
  const client = registry.clients.find((entry) => entry.id === id);
  if (client === undefined) {
    throw new McpClientNotFoundError(id, registryClientIds(registry));
  }
  return client;
}

/** A launcher by id, defaulting to `path`. */
export function launcherById(
  registry: McpRegistry,
  id: string | undefined,
): {
  readonly id: string;
  readonly launcher: Launcher;
} {
  const launcherId = id ?? 'path';
  const launcher = registry.launchers[launcherId];
  if (launcher === undefined) {
    throw new McpRegistryError(`no launcher named '${launcherId}'`, {
      hint: `known launchers: ${Object.keys(registry.launchers).join(', ')}`,
    });
  }
  return { id: launcherId, launcher };
}

/** A scope by id, defaulting to the client's `default: true` scope (or its only scope). */
export function scopeById(client: McpClient, id: string | undefined): ClientScope {
  if (id === undefined) {
    const fallback =
      client.scopes.find((scope) => scope.default === true) ??
      (client.scopes.length === 1 ? client.scopes[0] : undefined);
    if (fallback === undefined) {
      throw new McpRegistryError(`client '${client.id}' has no default scope`, {
        hint: `pass --scope: ${client.scopes.map((scope) => scope.id).join(', ')}`,
      });
    }
    return fallback;
  }
  const scope = client.scopes.find((entry) => entry.id === id);
  if (scope === undefined) {
    throw new McpRegistryError(`client '${client.id}' has no scope '${id}'`, {
      hint: `known scopes: ${client.scopes.map((entry) => entry.id).join(', ')}`,
    });
  }
  return scope;
}

/** The container a scope renders into: its own override, else the client document's. */
export function containerFor(client: McpClient, scope: ClientScope): readonly string[] {
  return scope.container ?? client.document.container;
}
