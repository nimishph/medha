import { McpRegistryError } from '../errors.ts';
import { VERSION } from '../version.ts';
import type { ClientScope, Launcher, McpClient, McpRegistry, TemplateValue } from './registry.ts';
import { containerFor, launcherById, scopeById } from './registry.ts';

/**
 * Interprets a client's declarative template into an actual config document. Every dialect
 * difference between MCP clients (root key, field names, command/args split vs argv array) is
 * expressed in clients.json; this module only walks that data.
 *
 * Template rules:
 * - a string starting with `${version}` has it substituted with the CLI version first;
 * - a string still starting with `$` is a reference: `$argv`, `$argv[i]`, `$argv[i:]`,
 *   `$argv[i:j]`, `$env`, `$serverName` — anything else is an unknown reference and fails;
 * - any other string, number or boolean is a literal;
 * - objects and arrays resolve recursively, and keys resolving to an empty value (empty string,
 *   object or array) are omitted, which is how `$env` disappears when the launcher has none.
 */

/** `$argv`, `$argv[0]`, `$argv[1:]`, `$argv[0:2]` — with the colon deciding slice vs element. */
const ARGV_REF = /^\$argv(?:\[(\d+)(:)?(\d+)?\])?$/;

/** The one placeholder the renderer substitutes (`${version}`), shared with docs generation. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder text, not interpolation.
export const VERSION_PLACEHOLDER = '${version}';

export interface RenderOptions {
  readonly scopeId?: string | undefined;
  readonly launcherId?: string | undefined;
  readonly serverName?: string | undefined;
  readonly version?: string | undefined;
}

export interface RenderedConfig {
  readonly client: McpClient;
  readonly scope: ClientScope;
  readonly container: readonly string[];
  readonly launcherId: string;
  readonly launcher: Launcher;
  readonly serverName: string;
  /** The single server object the template produced, before the container wraps it. */
  readonly entry: Record<string, unknown>;
  /** The document as it would be written for this scope: `{ <container>: { <name>: entry } }`. */
  readonly document: Record<string, unknown>;
  /** `document` as pretty JSON with a trailing newline, ready to print or commit. */
  readonly text: string;
}

interface ResolveContext {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly serverName: string;
  readonly version: string;
  readonly where: string;
}

/**
 * Resolve a client's template into the server entry object. Throws `McpRegistryError` on an
 * unknown reference or an out-of-range `$argv` index, naming the client it came from.
 */
export function renderServerEntry(
  template: Readonly<Record<string, TemplateValue>>,
  options: {
    readonly launcher: Launcher;
    readonly serverName: string;
    readonly version?: string | undefined;
    readonly where: string;
  },
): Record<string, unknown> {
  const version = options.version ?? VERSION;
  const substitute = (text: string): string =>
    text.includes(VERSION_PLACEHOLDER) ? text.replaceAll(VERSION_PLACEHOLDER, version) : text;
  const ctx: ResolveContext = {
    argv: options.launcher.argv.map(substitute),
    env: Object.fromEntries(
      Object.entries(options.launcher.env ?? {}).map(([key, value]) => [key, substitute(value)]),
    ),
    serverName: options.serverName,
    version,
    where: options.where,
  };
  const resolved = resolveObject(template, ctx);
  if (resolved.command === undefined && resolved.url === undefined) {
    throw new McpRegistryError(
      `client '${options.where}' renders a server entry with neither 'command' nor 'url'`,
      { hint: 'every template must produce a launchable server entry' },
    );
  }
  return resolved;
}

/** Render the full config document for one client (and scope/launcher selection). */
export function renderConfig(
  registry: McpRegistry,
  client: McpClient,
  options: RenderOptions = {},
): RenderedConfig {
  const scope = scopeById(client, options.scopeId);
  const { id: launcherId, launcher } = launcherById(registry, options.launcherId);
  const serverName = options.serverName ?? registry.serverName;
  const entry = renderServerEntry(client.document.template, {
    launcher,
    serverName,
    ...(options.version === undefined ? {} : { version: options.version }),
    where: client.id,
  });
  const container = containerFor(client, scope);
  const document = nestDocument(container, serverName, entry);
  return {
    client,
    scope,
    container,
    launcherId,
    launcher,
    serverName,
    entry,
    document,
    text: textOf(document),
  };
}

/** Every client, its default scope, the `path` launcher — what docs and `--all` enumerate. */
export function renderAll(registry: McpRegistry, options: RenderOptions = {}): RenderedConfig[] {
  return registry.clients.map((client) => renderConfig(registry, client, options));
}

/** Pretty JSON with a trailing newline, the file and snippet shape everywhere. */
export function textOf(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Set `value` at `container` inside an existing document, creating intermediate objects and
 * keeping every other key. The merge used by `--write`: a file holding other servers or unrelated
 * settings survives untouched around the medha entry.
 */
export function setAtPath(
  document: Record<string, unknown>,
  container: readonly string[],
  value: unknown,
): void {
  const root = container[0];
  if (root === undefined) {
    throw new McpRegistryError('container path is empty');
  }
  let node = document;
  for (let i = 0; i < container.length - 1; i += 1) {
    const key = container[i] as string;
    const next: unknown = node[key];
    if (next === undefined) {
      const created: Record<string, unknown> = {};
      node[key] = created;
      node = created;
      continue;
    }
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      throw new McpRegistryError(
        `cannot merge into '${container.join('.')}': '${key}' is not a JSON object`,
        { hint: 'the target file holds something unexpected where the server map should be' },
      );
    }
    node = next as Record<string, unknown>;
  }
  const leaf = container[container.length - 1] as string;
  node[leaf] = value;
}

function nestDocument(
  container: readonly string[],
  serverName: string,
  entry: Record<string, unknown>,
): Record<string, unknown> {
  let node: Record<string, unknown> = { [serverName]: entry };
  for (let i = container.length - 1; i >= 0; i -= 1) {
    const key = container[i] as string;
    node = { [key]: node };
  }
  return node;
}

function resolveObject(
  template: Readonly<Record<string, TemplateValue>>,
  ctx: ResolveContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(template)) {
    const resolved = resolveValue(value, ctx);
    if (resolved === undefined || isEmpty(resolved)) continue;
    out[key] = resolved;
  }
  return out;
}

function resolveValue(value: TemplateValue, ctx: ResolveContext): unknown {
  if (typeof value === 'string') return resolveString(value, ctx);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const resolved = resolveValue(item, ctx);
      if (resolved !== undefined && !isEmpty(resolved)) out.push(resolved);
    }
    return out;
  }
  if (typeof value === 'object' && value !== null) return resolveObject(value, ctx);
  return value;
}

function resolveString(raw: string, ctx: ResolveContext): unknown {
  const substituted = raw.includes(VERSION_PLACEHOLDER)
    ? raw.replaceAll(VERSION_PLACEHOLDER, ctx.version)
    : raw;
  if (!substituted.startsWith('$')) return substituted;
  return resolveRef(substituted, ctx);
}

function resolveRef(ref: string, ctx: ResolveContext): unknown {
  if (ref === '$serverName') return ctx.serverName;
  if (ref === '$env') return { ...ctx.env };
  const argvRef = ARGV_REF.exec(ref);
  if (argvRef !== null) {
    const startText = argvRef[1];
    if (startText === undefined) return [...ctx.argv];
    const start = Number(startText);
    const isSlice = argvRef[2] !== undefined;
    const endText = argvRef[3];
    if (isSlice) {
      if (start > ctx.argv.length) throw argvOutOfRange(ref, ctx);
      return endText === undefined ? [...ctx.argv.slice(start)] : sliceTo(start, endText, ctx, ref);
    }
    const element = ctx.argv[start];
    if (element === undefined) throw argvOutOfRange(ref, ctx);
    return element;
  }
  throw new McpRegistryError(`client '${ctx.where}': unknown template reference '${ref}'`, {
    hint: 'references are $argv, $argv[i], $argv[i:], $argv[i:j], $env, $serverName',
  });
}

function sliceTo(start: number, endText: string, ctx: ResolveContext, ref: string): string[] {
  const end = Number(endText);
  if (start > end || end > ctx.argv.length) throw argvOutOfRange(ref, ctx);
  return [...ctx.argv.slice(start, end)];
}

function argvOutOfRange(ref: string, ctx: ResolveContext): McpRegistryError {
  return new McpRegistryError(
    `client '${ctx.where}': ${ref} is out of range (argv has ${ctx.argv.length} elements)`,
    { hint: 'fix the reference, or the launcher argv it reads from' },
  );
}

function isEmpty(value: unknown): boolean {
  if (value === '' || value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === 'object' && Object.keys(value).length === 0;
}
