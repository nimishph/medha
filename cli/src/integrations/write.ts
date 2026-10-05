import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, normalize, resolve } from 'node:path';
import { ConfigFileError, McpRegistryError } from '../errors.ts';
import type { McpRegistry, PathSpec } from './registry.ts';
import { clientById } from './registry.ts';
import type { RenderedConfig, RenderOptions } from './render.ts';
import { renderConfig, setAtPath, textOf } from './render.ts';

/**
 * Where a client's config file lives on this machine, and how the medha entry is merged into it.
 * Paths stay declarative in clients.json (including per-OS variants); this module only picks and
 * expands them, then deep-sets the rendered entry so every other server and setting survives.
 */

export interface PathContext {
  readonly platform?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly home?: string | undefined;
  readonly cwd?: string | undefined;
}

/** The path as the registry writes it: a plain string, or every per-OS variant labelled. */
export function displayPath(spec: PathSpec): string {
  if (typeof spec === 'string') return spec;
  const parts: string[] = [];
  if (spec.darwin !== undefined) parts.push(`${spec.darwin} (macOS)`);
  if (spec.windows !== undefined) parts.push(`${spec.windows} (Windows)`);
  parts.push(`${spec.default} (Linux/other)`);
  return parts.join(' · ');
}

/** Pick this platform's variant from a per-OS spec (`win32`/`darwin`/`linux`, else default). */
export function pickPath(spec: PathSpec, platform: string | undefined): string {
  if (typeof spec === 'string') return spec;
  const key = platform === 'win32' ? spec.windows : platform === 'darwin' ? spec.darwin : undefined;
  const chosen = key ?? spec.default;
  return chosen;
}

const ENV_WINDOWS = /%([A-Za-z_][A-Za-z0-9_]*)%/g;
const ENV_BRACE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * A concrete absolute path: pick the platform variant, expand `~` and `%VAR%`/`${VAR}` from the
 * environment, then anchor project-relative paths at `cwd`. An unset variable is an error, not a
 * silent literal — a config file written with `%APPDATA%` still in it would never load.
 */
export function resolvePath(spec: PathSpec, context: PathContext = {}): string {
  const home = context.home ?? homedir();
  const env = context.env ?? {};
  let path = pickPath(spec, context.platform);
  if (path === '~') {
    path = home;
  } else if (path.startsWith('~/') || path.startsWith('~\\')) {
    path = `${home}${path.slice(1)}`;
  }
  // Function replacer: the return value replaces the whole match (`%VAR%` / `${VAR}`), so it is
  // the value itself, not a rewrite of the match.
  const expand = (_match: string, name: string): string => {
    const value = env[name];
    if (value === undefined || value === '') {
      throw new McpRegistryError(`cannot resolve config path '${path}': ${name} is not set`, {
        hint: `set ${name}, or edit clients.json to use a different path`,
      });
    }
    return value;
  };
  path = path.replace(ENV_WINDOWS, expand).replace(ENV_BRACE, expand);
  const cwd = context.cwd ?? process.cwd();
  return isAbsolute(path) ? normalize(path) : resolve(cwd, path);
}

export interface WriteOptions extends RenderOptions {
  readonly scopeId?: string | undefined;
  readonly context?: PathContext | undefined;
}

export interface WriteResult {
  readonly path: string;
  readonly created: boolean;
  readonly changed: boolean;
  readonly rendered: RenderedConfig;
}

/**
 * Merge the rendered entry into the scope's config file, creating directories and the file itself
 * as needed. An existing file must be a JSON object; anything else is reported rather than
 * overwritten. Returns `changed: false` (and skips the write) when the file is already current.
 */
export function writeClientConfig(
  registry: McpRegistry,
  clientId: string,
  options: WriteOptions = {},
): WriteResult {
  const client = clientById(registry, clientId);
  const rendered = renderConfig(registry, client, options);
  const path = resolvePath(rendered.scope.path, options.context ?? {});
  const exists = existsSync(path);
  let existing: Record<string, unknown> = {};
  let previousText: string | null = null;
  if (exists) {
    previousText = readFileSync(path, 'utf8');
    existing = parseObject(path, previousText);
  }
  // The leaf is the server itself, not the map: siblings in the map survive the merge.
  setAtPath(existing, [...rendered.container, rendered.serverName], rendered.entry);
  const text = textOf(existing);
  const changed = previousText !== text;
  if (changed) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, 'utf8');
  }
  return { path, created: !exists, changed, rendered };
}

function parseObject(path: string, text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ConfigFileError(path, 'not valid JSON', { cause });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigFileError(path, 'expected a JSON object at the root');
  }
  return parsed as Record<string, unknown>;
}
