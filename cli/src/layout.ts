import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  CANONICAL_SIGNALS,
  InvalidArgumentError,
  KindRegistry,
  type KindSpec,
  type SignalSpec,
  type StorePort,
  type StoreRegistries,
  validateSignalSpec,
} from '@cntxt-labs/medha-core';
import {
  FilePolicyStore,
  MemoryStore,
  resolveRegistries,
  SQLiteStore,
} from '@cntxt-labs/medha-store';
import { ConfigFileError, type RegistryDiff } from './errors.ts';

/**
 * Engine-home layout (owner decision, Loom-ujs3.11.2 — no version suffix): one directory
 * (`.medha/` by default, `--home` to override), with `config.json` as the single source of truth for registries and backend/path.
 * One distinct store file per backend: sqlite writes `store.sqlite` (+ `-wal`/`-shm`), the file
 * backend writes `state.jsonl` (+ `state.jsonl.bak`) as a git-trackable, human-diffable document
 * (the FilePolicyStore's `document`/`backup` names), memory persists nothing. Standalone medha
 * never touches `.sutra/`; pass `--home .sutra/medha` to opt in to a host-shared home.
 */

export type Backend = 'sqlite' | 'file' | 'memory';

export const BACKENDS: readonly Backend[] = ['sqlite', 'file', 'memory'];

export const MEDHA_HOME_REL = '.medha';
export const CONFIG_FILE = 'config.json';
export const SQLITE_STORE_FILE = 'store.sqlite';
export const FILE_STORE_DOCUMENT = 'state.jsonl';

export const CONFIG_LAYOUT_VERSION = 1;

export interface MedhaConfigV1 {
  readonly layoutVersion: 1;
  readonly backend: Backend;
  /** The absolute store path: the db file (sqlite), the document file (file), null (memory). */
  readonly path: string | null;
  /** The effective registries — config.json is the SINGLE SOURCE OF TRUTH (spec decision). */
  readonly registries: StoreRegistries;
  /**
   * When set, the *engine* this home builds (`openHome().engine`, and therefore every read/write
   * CLI command and the MCP server) is restricted to these namespaces via `scopeStore` — for a
   * store shared by more than one project/tenant. Host/admin surfaces (`sync`, `maintain`,
   * `report`, `ui`) use `openHome().adminEngine` / `openHome().store` instead, which always see
   * the whole store: holding this home's config already means holding the store, and a `--namespace`
   * config is a boundary for agent-facing operations, not a partition invisible to the operator.
   */
  readonly namespaceScope?: readonly string[];
}

/** `home` (from `--home`) overrides the default `<dir>/.medha`; relative paths resolve against `dir`. */
export function homeFor(dir: string, home?: string): string {
  return resolve(dir, home ?? MEDHA_HOME_REL);
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
/** The raw, unscoped store a config.json commits to — see `namespaceScope` on `MedhaConfigV1`. */
export function storeForConfig(config: MedhaConfigV1): StorePort {
  switch (config.backend) {
    case 'sqlite':
      return new SQLiteStore({
        path: config.path as string,
        registries: config.registries,
        resilientReplay: true,
      });
    case 'file':
      return new FilePolicyStore({
        dir: dirname(config.path as string),
        document: basename(config.path as string),
        backup: `${basename(config.path as string)}.bak`,
        registries: config.registries,
        resilientReplay: true,
      });
    case 'memory':
      return new MemoryStore({ registries: config.registries });
  }
}

/** The opinions a user may override or add to, written to an optional --config registries.json. */
export interface HostRegistries {
  readonly kinds?:
    | readonly string[]
    | Record<string, Partial<KindSpec>>
    | readonly (string | KindSpec)[];
  readonly kindSpecs?: readonly KindSpec[];
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

  const extractedKinds: string[] = [];
  const extractedKindSpecs: KindSpec[] = [];

  if (host.kinds !== undefined) {
    if (Array.isArray(host.kinds)) {
      for (const item of host.kinds) {
        if (typeof item === 'string') {
          if (item.trim() === '') {
            throw new ConfigFileError(configPath, 'kinds must be an array of non-empty strings');
          }
          extractedKinds.push(item);
          extractedKindSpecs.push({ name: item });
        } else if (typeof item === 'object' && item !== null) {
          const spec = item as KindSpec;
          if (typeof spec.name !== 'string' || spec.name.trim() === '') {
            throw new ConfigFileError(configPath, 'kind spec must have a non-empty string name');
          }
          extractedKinds.push(spec.name);
          extractedKindSpecs.push(spec);
        } else {
          throw new ConfigFileError(
            configPath,
            'kinds must be an array of non-empty strings or KindSpec objects',
          );
        }
      }
    } else if (typeof host.kinds === 'object' && host.kinds !== null) {
      for (const [name, rawSpec] of Object.entries(host.kinds)) {
        if (typeof name !== 'string' || name.trim() === '') {
          throw new ConfigFileError(
            configPath,
            'kind name in kinds object must be a non-empty string',
          );
        }
        if (typeof rawSpec !== 'object' || rawSpec === null) {
          throw new ConfigFileError(
            configPath,
            `kind configuration for '${name}' must be an object`,
          );
        }
        extractedKinds.push(name);
        extractedKindSpecs.push({ name, ...rawSpec });
      }
    } else {
      throw new ConfigFileError(
        configPath,
        'kinds must be an array of non-empty strings or a configuration object',
      );
    }
  }

  if (host.kindSpecs !== undefined) {
    if (!Array.isArray(host.kindSpecs)) {
      throw new ConfigFileError(configPath, 'kindSpecs must be an array');
    }
    for (const spec of host.kindSpecs) {
      if (
        typeof spec !== 'object' ||
        spec === null ||
        typeof spec.name !== 'string' ||
        spec.name.trim() === ''
      ) {
        throw new ConfigFileError(
          configPath,
          'each kindSpec must be an object with a non-empty name',
        );
      }
      if (!extractedKinds.includes(spec.name)) {
        extractedKinds.push(spec.name);
      }
      const existingIdx = extractedKindSpecs.findIndex((s) => s.name === spec.name);
      if (existingIdx >= 0) {
        extractedKindSpecs[existingIdx] = { ...extractedKindSpecs[existingIdx], ...spec };
      } else {
        extractedKindSpecs.push(spec);
      }
    }
  }

  try {
    new KindRegistry(extractedKindSpecs);
  } catch (failure) {
    throw new ConfigFileError(
      configPath,
      failure instanceof Error ? failure.message : String(failure),
      { cause: failure },
    );
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
      const builtin = CANONICAL_SIGNALS.find((s) => s.name === spec.name);
      if (builtin !== undefined) {
        if (
          builtin.value !== spec.value ||
          builtin.countsAsTrial !== spec.countsAsTrial ||
          builtin.countsAsSuccess !== spec.countsAsSuccess
        ) {
          throw new ConfigFileError(
            configPath,
            `cannot redefine built-in signal '${spec.name}'; built-in signals have canonical semantics (expected value=${builtin.value}, countsAsTrial=${builtin.countsAsTrial}, countsAsSuccess=${builtin.countsAsSuccess})`,
          );
        }
      }
      if (seen.has(spec.name)) {
        throw new ConfigFileError(configPath, `signalSpecs defines '${spec.name}' twice`);
      }
      seen.set(spec.name, spec);
    }
  }
  const hostRegistries: StoreRegistries = {
    kinds: extractedKinds,
    kindSpecs: extractedKindSpecs,
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
export function readConfig(home: string): MedhaConfigV1 | null {
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
  const candidate = parsed as Partial<MedhaConfigV1>;
  if (candidate.namespaceScope !== undefined && !isNameList(candidate.namespaceScope)) {
    throw new ConfigFileError(path, 'namespaceScope must be an array of non-empty strings');
  }
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
    ...(candidate.namespaceScope === undefined ? {} : { namespaceScope: candidate.namespaceScope }),
  };
}

function describeThrowable(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

export function writeConfig(home: string, config: MedhaConfigV1): string {
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

const GITIGNORE_HEADER = `# Written by \`medha init\`. Safe to edit or delete.
#
# config.json is NOT listed here: it is a small, human-authored registry definition (kinds,
# signals, thresholds), meant to be committed like any other project config file.
#
# Everything below is either local-only mechanics or data that has its own sync channel
# (\`medha sync\`, over a dedicated git ref or a snapshot file) — tracking it here too would
# duplicate that channel and produce merge conflicts an ordinary git merge cannot resolve.
`;

/** `.medha/.gitignore`: the store's data (synced by \`medha sync\`, not git) plus local-only artifacts. */
export function writeGitignore(home: string, backend: Backend, storeFileName: string): string {
  const path = join(home, '.gitignore');
  const lines =
    backend === 'sqlite'
      ? [
          `# The store itself: medha sync moves this data, not ordinary commits.`,
          storeFileName,
          '',
          `# Local-only: SQLite's WAL-mode journal, regenerated and meaningless without the store above.`,
          `${storeFileName}-wal`,
          `${storeFileName}-shm`,
          `${storeFileName}-journal`,
        ]
      : [
          `# The store itself: medha sync moves this data, not ordinary commits.`,
          storeFileName,
          '',
          `# Local-only: the atomic-write backup and in-flight temp file.`,
          `${storeFileName}.bak`,
          `${storeFileName}.tmp`,
        ];
  writeFileSync(path, `${GITIGNORE_HEADER}\n${lines.join('\n')}\n`, 'utf8');
  return path;
}

const README_TEMPLATE = (backend: Backend): string => `# .medha/

This directory is a [Medha](https://github.com/nimishph/medha) evidential-memory store, created
by \`medha init\`. It records what happened to your rules, recipes, and tools, and returns trust
hints — it never decides anything for you.

## What's here

- **\`config.json\`** — the single source of truth: backend, store path, and the registries
  (kinds, signals, thresholds). Meant to be committed; it's small and human-reviewable.
- **the store itself** (\`${backend === 'sqlite' ? 'store.sqlite' : 'state.jsonl'}\`) — the
  append-only episode log Medha folds into trust. Gitignored by default: share it with a team via
  \`medha sync\` (a dedicated git ref or a snapshot file), not by committing it directly. If you'd
  rather commit it as a simple, manual sync, delete or edit \`.gitignore\`.

## Useful commands

\`\`\`sh
medha list                                # what Medha knows, ranked by trust
medha maintain preflight                  # verify store integrity and registry match
medha maintain backup snapshot.json       # atomic, portable snapshot
medha sync status                         # compare against the shared ref/file
\`\`\`

Run \`medha --help\` for the full command surface.
`;

/** `.medha/README.md`: a static explainer so whoever finds this directory knows what it is. */
export function writeReadme(home: string, backend: Backend): string {
  const path = join(home, 'README.md');
  writeFileSync(path, README_TEMPLATE(backend), 'utf8');
  return path;
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
