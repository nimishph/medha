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
import { type AgentFileResult, agentTargets, applyAgentSection } from './agent-instructions.ts';
import type { Environment } from './environment.ts';
import type { RegistryDiff } from './errors.ts';
import { RegistryDriftError, StoreCorruptError } from './errors.ts';
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
  storeForConfig,
  writeConfig,
  writeGitignore,
  writeReadme,
  writeSnapshot,
} from './layout.ts';
import { VERSION } from './version.ts';

/**
 * `medha init` (spec §9.1, the write-plane bootstrap): resolve the engine home under `--dir`, build
 * registries from `--config` (or the built-ins), construct the store the configured backend asked
 * for, stamp the last-sweep marker with a host-invoked `open`, gate on preflight, and write the
 * registries into `config.json` as the single source of truth — plus an optional bootstrap
 * snapshot. Headless by construction: nothing here reads a TTY, and the ephemeral memory backend
 * persists nothing at all.
 *
 * Running it again on an initialized home is safe and is how an upgrade reaches the project: the
 * store and config.json are left exactly as they are (only `--recreate` wipes), preflight runs
 * against them, and the generated project files — the medha section of the agent instruction file
 * — are brought up to this version.
 */

/** The section `init` keeps in the project's AGENTS.md / CLAUDE.md (see agent-instructions.ts). */
export const AGENT_SECTION = `## Evidential memory: medha

This project tracks how well its rules, recipes and tools actually work in [medha](https://nimishph.github.io/medha/)
(engine home: \`.medha/\`). Medha reports evidence and trust hints; **you** decide what to do with them.

- Before leaning on a project rule, recipe or tool, check its trust: \`medha show --id <id>\` (add
  \`--kind recipe|tool\` for non-rules). Unknown entities are \`probation\`: weigh them lightly.
- \`medha pack --budget 2000\` gives the most trusted guidance that fits a token budget.
- After using one, record what happened: \`medha record --id <id> --signal APPLY\` (or
  \`REJECT_RULE\`, \`SKIP\`; \`--ensure\` creates a new entity).
- When a check confirms or refutes it (tests, review, audit): \`medha guard --id <id> --ok|--fail --guard <kind>\`.
- \`medha primer [topic]\` explains any of this in a few lines. If a \`medha\` MCP server is
  connected, its tools do the same.`;

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
  /**
   * The agent instruction file to keep the medha section in, relative to `dir`; `false` writes none
   * (`--no-agents-file`). Default: AGENTS.md and/or CLAUDE.md, see `agentTargets`.
   */
  readonly agentsFile?: string | false;
}

export interface InitReport {
  /** `existing` when the home was already initialized and init only refreshed what it generates. */
  readonly status: 'initialized' | 'recreated' | 'existing';
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
  /** The agent instruction files init wrote the medha section into (empty for memory / opt-out). */
  readonly agentFiles: readonly AgentFileResult[];
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
      status: 'initialized',
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
      agentFiles: [],
    };
  }

  const agentFiles = (): readonly AgentFileResult[] =>
    options.agentsFile === false
      ? []
      : applyAgentSection(
          options.dir,
          agentTargets(options.dir, options.agentsFile),
          'medha',
          VERSION,
          AGENT_SECTION,
        );

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
      // Already initialized: leave the store and config.json alone, check them, and bring the
      // generated project files up to this version. A scope change is a re-init, not a refresh.
      if (requestedScope !== undefined || options.noNamespace === true) {
        throw new InvalidArgumentError(
          options.noNamespace === true ? '--no-namespace' : '--namespace',
          `--recreate alongside it: ${home} is already initialized`,
          options.namespace,
        );
      }
      const preflight = await bootstrap(storeForConfig(existing), options.backup);
      return {
        status: 'existing',
        home,
        backend: existing.backend,
        path: existing.path ?? null,
        config: configPathFor(home),
        layoutVersion: existing.layoutVersion,
        preflight,
        registryDrift: null,
        backup: options.backup ?? null,
        namespaceScope: existing.namespaceScope ?? null,
        gitignore: null,
        readme: null,
        agentFiles: agentFiles(),
      };
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
    status: options.recreate ? 'recreated' : 'initialized',
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
    agentFiles: agentFiles(),
  };
}

export type { MedhaSnapshot };
