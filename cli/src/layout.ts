import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  InvalidArgumentError,
  type SignalSpec,
  type StorePort,
  type StoreRegistries,
  validateSignalSpec,
} from '@sutras/sage-core';
import { FilePolicyStore, MemoryStore, resolveRegistries, SQLiteStore } from '@sutras/sage-store';
import { ConfigFileError, type RegistryDiff } from './errors.ts';

/**
 * Engine-home layout (owner decision, Loom-ujs3.11.2 — no version suffix): one directory under
 * `.sutra/`, with `config.json` as the single source of truth for registries and backend/path.
 * One distinct store file per backend: sqlite writes `store.sqlite` (+ `-wal`/`-shm`), the file
 * backend writes `state.jsonl` (+ `state.jsonl.bak`) as a git-trackable, human-diffable document
 * (the FilePolicyStore's `document`/`backup` names), memory persists nothing. Legacy
 * `.sutra/sage/` files are read by nothing until the Loom-ujs3.12 importer.
 */

export type Backend = 'sqlite' | 'file' | 'memory';

export const BACKENDS: readonly Backend[] = ['sqlite', 'file', 'memory'];

export const SAGE_HOME_REL = '.sutra/sage';
export const CONFIG_FILE = 'config.json';
export const SQLITE_STORE_FILE = 'store.sqlite';
export const FILE_STORE_DOCUMENT = 'state.jsonl';

export const CONFIG_LAYOUT_VERSION = 1;

export interface SageConfigV1 {
  readonly layoutVersion: 1;
  readonly backend: Backend;
  /** The absolute store path: the db file (sqlite), the document file (file), null (memory). */
  readonly path: string | null;
  /** The effective registries — config.json is the SINGLE SOURCE OF TRUTH (spec decision). */
  readonly registries: StoreRegistries;
}

export function homeFor(dir: string): string {
  return resolve(dir, SAGE_HOME_REL);
}

export function configPathFor(home: string): string {
  return join(home, CONFIG_FILE);
}

function defaultStorePath(backend: Backend, home: string): string {
  switch (backend) {
    case 'sqlite':
      return join(home, SQLITE_STORE_FILE);
    case 'file':
      return join(home, FILE_STORE_DOCUMENT);
    case 'memory':
      return join(home, 'memory');
  }
}

/**
 * The absolute store location a backend will use: the db file (sqlite), the document file (file).
 * `--path` with the ephemeral memory backend is a usage error — nothing is written, so a store
 * path is meaningless there.
 */
export function resolveStorePath(backend: Backend, home: string, explicit?: string): string | null {
  if (backend === 'memory') {
    if (explicit !== undefined) {
      throw new InvalidArgumentError(
        '--path',
        'no store path for the ephemeral memory backend',
        explicit,
      );
    }
    return null;
  }
  return resolve(explicit ?? defaultStorePath(backend, home));
}

/**
 * Rebuild the exact store a config.json commits to — the mirror of `init`'s construction. Any
 * read-plane command (list/show/…) reopens the home through this, so a configured home is always
 * read with the same backend, files, and registries it was written with.
 */
export function storeForConfig(config: SageConfigV1): StorePort {
  switch (config.backend) {
    case 'sqlite':
      return new SQLiteStore({ path: config.path as string, registries: config.registries });
    case 'file':
      return new FilePolicyStore({
        dir: dirname(config.path as string),
        document: basename(config.path as string),
        backup: `${basename(config.path as string)}.bak`,
        registries: config.registries,
      });
    case 'memory':
      return new MemoryStore({ registries: config.registries });
  }
}

/** The opinions a user may override or add to, written to an optional --config registries.json. */
export interface HostRegistries {
  readonly kinds?: readonly string[];
  readonly signalSpecs?: readonly SignalSpec[];
  readonly anchorKinds?: readonly string[];
}

/** Validate the whole effective registry set (built-ins + --config additions) before any store exists. */
export function effectiveRegistriesFrom(configPath: string): StoreRegistries {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (failure) {
    throw new ConfigFileError(configPath, 'not valid JSON', { cause: failure });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigFileError(configPath, 'expected a JSON object');
  }
  const host = parsed as Partial<HostRegistries>;
  if (host.kinds !== undefined && !isNameList(host.kinds)) {
    throw new ConfigFileError(configPath, 'kinds must be an array of non-empty strings');
  }
  if (host.anchorKinds !== undefined && !isNameList(host.anchorKinds)) {
    throw new ConfigFileError(configPath, 'anchorKinds must be an array of non-empty strings');
  }
  if (host.signalSpecs !== undefined) {
    if (!Array.isArray(host.signalSpecs)) {
      throw new ConfigFileError(configPath, 'signalSpecs must be an array');
    }
    const seen = new Map<string, SignalSpec>();
    for (const raw of host.signalSpecs) {
      if (typeof raw !== 'object' || raw === null) {
        throw new ConfigFileError(configPath, 'each signalSpec must be an object');
      }
      const spec = raw as SignalSpec;
      validateSignalSpec(spec);
      if (seen.has(spec.name)) {
        throw new ConfigFileError(configPath, `signalSpecs defines '${spec.name}' twice`);
      }
      seen.set(spec.name, spec);
    }
  }
  const hostRegistries: StoreRegistries = {
    kinds: host.kinds ?? [],
    signalSpecs: host.signalSpecs ?? [],
    anchorKinds: host.anchorKinds ?? [],
  };
  return resolveRegistries(hostRegistries);
}

function isNameList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.trim() !== '')
  );
}

/** Read + validate the home's existing config.json. Returns null when the home is empty. */
export function readConfig(home: string): SageConfigV1 | null {
  const path = configPathFor(home);
  if (!existsSync(path)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (failure) {
    throw new ConfigFileError(path, 'not valid JSON', { cause: failure });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigFileError(path, 'expected a JSON object');
  }
  const candidate = parsed as Partial<SageConfigV1>;
  if (candidate.layoutVersion !== CONFIG_LAYOUT_VERSION) {
    throw new ConfigFileError(path, `unsupported layoutVersion ${String(candidate.layoutVersion)}`);
  }
  if (!(BACKENDS as readonly string[]).includes(candidate.backend as string)) {
    throw new ConfigFileError(path, `unknown backend ${String(candidate.backend)}`);
  }
  if (typeof candidate.path !== 'string' && candidate.path !== null) {
    throw new ConfigFileError(path, 'path must be a string or null');
  }
  const registries = candidate.registries;
  if (typeof registries !== 'object' || registries === null || Array.isArray(registries)) {
    throw new ConfigFileError(path, 'registries must be an object');
  }
  if (!isNameList(registries.kinds)) {
    throw new ConfigFileError(path, 'registries.kinds must be an array of non-empty strings');
  }
  if (!isNameList(registries.anchorKinds)) {
    throw new ConfigFileError(path, 'registries.anchorKinds must be an array of non-empty strings');
  }
  if (!Array.isArray(registries.signalSpecs)) {
    throw new ConfigFileError(path, 'registries.signalSpecs must be an array');
  }
  for (const raw of registries.signalSpecs) {
    if (typeof raw !== 'object' || raw === null) {
      throw new ConfigFileError(path, 'each signalSpec must be an object');
    }
    try {
      validateSignalSpec(raw as SignalSpec);
    } catch (failure) {
      throw new ConfigFileError(path, `invalid signal spec: ${describeThrowable(failure)}`, {
        cause: failure,
      });
    }
  }
  return {
    layoutVersion: CONFIG_LAYOUT_VERSION,
    backend: candidate.backend as Backend,
    path: candidate.path === undefined ? null : candidate.path,
    registries: registries as StoreRegistries,
  };
}

function describeThrowable(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

export function writeConfig(home: string, config: SageConfigV1): string {
  const path = configPathFor(home);
  mkdirSync(home, { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return path;
}

export function writeSnapshot(path: string, snapshot: unknown): void {
  const location = resolve(path);
  mkdirSync(dirname(location), { recursive: true });
  writeFileSync(location, `${JSON.stringify({ snapshot }, null, 2)}\n`, 'utf8');
}

export function removeStoreArtifacts(backend: Backend, storePath: string): void {
  if (backend === 'sqlite') {
    for (const artifact of [storePath, `${storePath}-wal`, `${storePath}-shm`]) {
      rmSync(artifact, { force: true, maxRetries: 5, retryDelay: 50 });
    }
    return;
  }
  for (const artifact of [storePath, `${storePath}.bak`, `${storePath}.tmp`]) {
    rmSync(artifact, { force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function signalKey(spec: SignalSpec): string {
  return `${spec.value}|${spec.countsAsTrial ? 1 : 0}|${spec.countsAsSuccess ? 1 : 0}`;
}

function sortedSet(values: readonly string[]): string {
  return [...new Set(values)].sort().join('\u0000');
}

/** Two registry sets commit to exactly the same kinds, signal semantics, and anchors. */
export function registryEquals(a: StoreRegistries, b: StoreRegistries): boolean {
  if (sortedSet(a.kinds) !== sortedSet(b.kinds)) {
    return false;
  }
  if (sortedSet(a.anchorKinds) !== sortedSet(b.anchorKinds)) {
    return false;
  }
  const byName = (registries: StoreRegistries): Map<string, SignalSpec> =>
    new Map(registries.signalSpecs.map((spec) => [spec.name, spec] as const));
  const ma = byName(a);
  const mb = byName(b);
  if (ma.size !== mb.size) {
    return false;
  }
  for (const [name, spec] of ma) {
    const other = mb.get(name);
    if (other === undefined || signalKey(spec) !== signalKey(other)) {
      return false;
    }
  }
  return true;
}

/** Additive/removed/changed registry differences between two sets (order-insensitive). */
export function registryDiff(a: StoreRegistries, b: StoreRegistries): RegistryDiff {
  const kinds = nameSetDiff(a.kinds, b.kinds);
  const anchors = nameSetDiff(a.anchorKinds, b.anchorKinds);
  const sa = new Map(a.signalSpecs.map((spec) => [spec.name, spec] as const));
  const sb = new Map(b.signalSpecs.map((spec) => [spec.name, spec] as const));
  const added = [...sb.keys()].filter((name) => !sa.has(name)).sort();
  const removed = [...sa.keys()].filter((name) => !sb.has(name)).sort();
  const changed: { name: string; config: SignalSpec; requested: SignalSpec }[] = [];
  for (const [name, spec] of sa) {
    const other = sb.get(name);
    if (other !== undefined && signalKey(spec) !== signalKey(other)) {
      changed.push({ name, config: spec, requested: other });
    }
  }
  return { kinds, signals: { added, removed, changed }, anchors };
}

function nameSetDiff(
  a: readonly string[],
  b: readonly string[],
): { added: readonly string[]; removed: readonly string[] } {
  const sa = new Set(a);
  const sb = new Set(b);
  return {
    added: [...sb].filter((entry) => !sa.has(entry)).sort(),
    removed: [...sa].filter((entry) => !sb.has(entry)).sort(),
  };
}
