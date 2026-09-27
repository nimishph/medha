import { basename, dirname } from 'node:path';
import {
  Medha,
  type MedhaSnapshot,
  type PreflightReport,
  type SessionOpenResult,
} from '@cntxt-labs/medha';
import { InvalidArgumentError, type StorePort, type StoreRegistries } from '@cntxt-labs/medha-core';
import {
  FilePolicyStore,
  MemoryStore,
  resolveRegistries,
  SQLiteStore,
} from '@cntxt-labs/medha-store';
import type { Environment } from './environment.ts';
import type { RegistryDiff } from './errors.ts';
import { HomeExistsError, RegistryDriftError, StoreCorruptError } from './errors.ts';
import {
  BACKENDS,
  type Backend,
  CONFIG_LAYOUT_VERSION,
  configPathFor,
  effectiveRegistriesFrom,
  homeFor,
  type MedhaConfigV1,
  readConfig,
  registryDiff,
  registryEquals,
  removeStoreArtifacts,
  resolveStorePath,
  writeConfig,
  writeGitignore,
  writeReadme,
  writeSnapshot,
} from './layout.ts';

/**
 * `medha init` (spec §9.1, the write-plane bootstrap): resolve the engine home under `--dir`, build
 * registries from `--config` (or the built-ins), construct the store the configured backend asked
 * for, stamp the last-sweep marker with a host-invoked `open`, gate on preflight, and write the
 * registries into `config.json` as the single source of truth — plus an optional bootstrap
 * snapshot. Headless by construction: nothing here reads a TTY, and the ephemeral memory backend
 * persists nothing at all.
 */

export interface InitOptions {
  readonly dir: string;
  readonly home?: string | undefined;
  readonly backend: string;
  readonly path?: string;
  readonly config?: string;
  readonly backup?: string;
  readonly recreate: boolean;
  /** Comma-separated namespaces; see `MedhaConfigV1.namespaceScope`. */
  readonly namespace?: string;
  /**
   * `--no-namespace`: drop an existing `namespaceScope` instead of carrying it over. Needed because
   * `--recreate` otherwise inherits the scope, and there would be no way to widen a home back out
   * without hand-editing config.json.
   */
  readonly noNamespace?: boolean;
}

export interface InitReport {
  readonly home: string;
  readonly backend: Backend;
  readonly path: string | null;
  readonly config: string | null;
  readonly layoutVersion: number | null;
  readonly preflight: PreflightReport;
  /** Non-null only when the freshly written config.json drifted from the store it created. */
  readonly registryDrift: {
    readonly config: StoreRegistries;
    readonly store: StoreRegistries;
    readonly diff: RegistryDiff;
  } | null;
  readonly backup: string | null;
  /** Namespaces this home's engine is restricted to, or null when unrestricted. */
  readonly namespaceScope: readonly string[] | null;
  /** null only for the ephemeral memory backend, which has no home directory to scaffold. */
  readonly gitignore: string | null;
  readonly readme: string | null;
}

/** Parse `--namespace`: a comma-separated, deduplicated, non-empty namespace list, or undefined. */
export function parseNamespaceScope(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const names = [
    ...new Set(
      value
        .split(',')
        .map((n) => n.trim())
        .filter((n) => n !== ''),
    ),
  ];
  if (names.length === 0) {
    throw new InvalidArgumentError('--namespace', 'at least one non-empty namespace', value);
  }
  return names;
}

export function normalizeBackend(value: string): Backend {
  if ((BACKENDS as readonly string[]).includes(value)) {
    return value as Backend;
  }
  throw new InvalidArgumentError('--store', `one of ${BACKENDS.join(', ')}`, value);
}

/**
 * The namespace scope the config.json about to be written gets.
 *
 * `--namespace` always wins and `--no-namespace` explicitly drops the scope. With neither, a scope
 * already in the config.json being replaced carries over: `--recreate` replaces the *data*, not the
 * home's identity, and deriving the scope from this invocation's flags alone silently dropped the
 * tenant boundary — leaving every later CLI/MCP operation on the unscoped `adminEngine` (medha-4yj).
 *
 * The carry-over read is best-effort by design: it runs only under `--recreate`, where config.json is
 * about to be overwritten regardless, and an unreadable config has no scope to preserve. That is
 * precisely the case `--recreate` exists to recover from, so it must not fail here. The strict read
 * on the non-recreate path is untouched.
 */
function resolveNamespaceScope(
  requested: readonly string[] | undefined,
  options: InitOptions,
  home: string,
): readonly string[] | undefined {
  if (requested !== undefined) {
    if (options.noNamespace === true) {
      throw new InvalidArgumentError(
        '--no-namespace',
        'no --namespace alongside it (they contradict)',
        options.namespace,
      );
    }
    return requested;
  }
  if (options.noNamespace === true) return undefined;
  if (!options.recreate) return undefined;
  try {
    return readConfig(home)?.namespaceScope;
  } catch {
    return undefined;
  }
}

export async function runInit(options: InitOptions, environment: Environment): Promise<InitReport> {
  const backend = normalizeBackend(options.backend);
  const requestedScope = parseNamespaceScope(options.namespace);
  const home = homeFor(options.dir, options.home);
  const storePath = resolveStorePath(backend, home, options.path);
  const now = environment.now();
  const requested =
    options.config === undefined
      ? resolveRegistries(undefined)
      : effectiveRegistriesFrom(options.config);

  const bootstrap = async (store: StorePort, backup?: string): Promise<PreflightReport> => {
    const engine = new Medha({ store });
    try {
      const session: SessionOpenResult = await engine.open({ now });
      if ('skipped' in session && session.skipped === 'store-corrupt') {
        throw new StoreCorruptError(session.location);
      }
      const preflight = await engine.preflight({ now });
      if (preflight.status !== 'ok') {
        throw new StoreCorruptError({ source: '', atSeq: 0 });
      }
      if (backup !== undefined) {
        await writeSnapshot(backup, (await engine.backup({ now })).snapshot);
      }
      return preflight;
    } finally {
      await engine.close();
    }
  };

  if (backend === 'memory') {
    const store = new MemoryStore({ registries: requested });
    const preflight = await bootstrap(store, options.backup);
    return {
      home,
      backend,
      path: null,
      config: null,
      layoutVersion: null,
      preflight,
      registryDrift: null,
      backup: options.backup ?? null,
      namespaceScope: requestedScope ?? null,
      gitignore: null,
      readme: null,
    };
  }

  const forcedStorePath = storePath as string;
  if (!options.recreate) {
    const existing = readConfig(home);
    if (existing !== null) {
      if (options.config !== undefined && !registryEquals(existing.registries, requested)) {
        throw new RegistryDriftError(
          configPathFor(home),
          existing.registries,
          requested,
          registryDiff(existing.registries, requested),
        );
      }
      throw new HomeExistsError(home);
    }
  }
  const namespaceScope = resolveNamespaceScope(requestedScope, options, home);
  if (options.recreate) {
    removeStoreArtifacts(backend, forcedStorePath);
  }

  const store: StorePort =
    backend === 'sqlite'
      ? new SQLiteStore({ path: forcedStorePath, registries: requested })
      : new FilePolicyStore({
          dir: dirname(forcedStorePath),
          document: basename(forcedStorePath),
          backup: `${basename(forcedStorePath)}.bak`,
          registries: requested,
        });

  const preflight = await bootstrap(store, options.backup);

  const config: MedhaConfigV1 = {
    layoutVersion: CONFIG_LAYOUT_VERSION,
    backend,
    path: forcedStorePath,
    registries: requested,
    ...(namespaceScope === undefined ? {} : { namespaceScope }),
  };
  const writtenPath = writeConfig(home, config);
  const gitignorePath = writeGitignore(home, backend, basename(forcedStorePath));
  const readmePath = writeReadme(home, backend);

  const stamp = readConfig(home) as MedhaConfigV1;
  const registryDrift = registryEquals(stamp.registries, store.registries)
    ? null
    : {
        config: stamp.registries,
        store: store.registries,
        diff: registryDiff(stamp.registries, store.registries),
      };

  return {
    home,
    backend,
    path: forcedStorePath,
    config: writtenPath,
    layoutVersion: CONFIG_LAYOUT_VERSION,
    preflight,
    registryDrift,
    backup: options.backup ?? null,
    namespaceScope: namespaceScope ?? null,
    gitignore: gitignorePath,
    readme: readmePath,
  };
}

export type { MedhaSnapshot };
