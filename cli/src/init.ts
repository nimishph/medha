import { basename, dirname } from 'node:path';
import {
  type MedhaSnapshot,
  type PreflightReport,
  Sage,
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
}

export function normalizeBackend(value: string): Backend {
  if ((BACKENDS as readonly string[]).includes(value)) {
    return value as Backend;
  }
  throw new InvalidArgumentError('--store', `one of ${BACKENDS.join(', ')}`, value);
}

export async function runInit(options: InitOptions, environment: Environment): Promise<InitReport> {
  const backend = normalizeBackend(options.backend);
  const home = homeFor(options.dir, options.home);
  const storePath = resolveStorePath(backend, home, options.path);
  const now = environment.now();
  const requested =
    options.config === undefined
      ? resolveRegistries(undefined)
      : effectiveRegistriesFrom(options.config);

  const bootstrap = async (store: StorePort, backup?: string): Promise<PreflightReport> => {
    const engine = new Sage({ store });
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
  };
  const writtenPath = writeConfig(home, config);

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
  };
}

export type { MedhaSnapshot };
