import {
  type CorruptLocation,
  MedhaError,
  type SignalSpec,
  type StoreRegistries,
} from '@cntxt-labs/medha-core';

/**
 * CLI-domain failures. Everything the engine or a store throws stays its own typed error; these
 * are the failures that only exist at the boundary (a home that exists, a registry that drifted,
 * a config file that does not parse). Codes keep the `CLI_` prefix.
 */

export interface RegistryDiff {
  readonly kinds: { readonly added: readonly string[]; readonly removed: readonly string[] };
  readonly signals: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly changed: readonly {
      readonly name: string;
      readonly config: SignalSpec;
      readonly requested: SignalSpec;
    }[];
  };
  readonly anchors: { readonly added: readonly string[]; readonly removed: readonly string[] };
}

export abstract class CliError extends MedhaError {
  override readonly subsystem = 'cli';
}

/** The engine home already has a config.json and init refused to touch it. */
export class HomeExistsError extends CliError {
  readonly code = 'CLI_ALREADY_INITIALIZED';

  constructor(home: string) {
    super(`${home} is already initialized; pass --recreate to wipe the engine store and re-init`, {
      context: { home },
    });
  }
}

/** A read/maintenance command ran in a directory with no engine home to open. */
export class HomeNotInitializedError extends CliError {
  readonly code = 'CLI_NOT_INITIALIZED';

  constructor(home: string) {
    super(`no engine home at ${home}`, {
      context: { home },
      hint: "run 'medha init' first (the ephemeral memory backend leaves nothing to reopen)",
    });
  }
}

/** `--config` would change the registries a configured home already commits to. */
export class RegistryDriftError extends CliError {
  readonly code = 'CLI_REGISTRY_DRIFT';

  constructor(
    configPath: string,
    readonly config: StoreRegistries,
    readonly requested: StoreRegistries,
    readonly diff: RegistryDiff,
  ) {
    super(
      `registries in ${configPath} differ from --config (${summarizeDiff(diff)}) — ` +
        'refusing: config.json is the single source of truth',
      { context: { configPath, config, requested, diff } },
    );
  }
}

/** A config file (the home's config.json, or one passed to --config) could not be used. */
export class ConfigFileError extends CliError {
  readonly code = 'CLI_CONFIG_INVALID';

  constructor(path: string, problem: string, init: { readonly cause?: unknown } = {}) {
    super(`cannot read ${path}: ${problem}`, { ...init, context: { path, problem } });
  }
}

/** `open()` reached a store whose log is unrecoverable; bootstrap stops before health can print. */
export class StoreCorruptError extends CliError {
  readonly code = 'CLI_STORE_CORRUPT';

  constructor(location: CorruptLocation) {
    super(`store is corrupt — the log is unrecoverable from seq ${location.atSeq}`, {
      context: { source: location.source, atSeq: location.atSeq },
      hint: 'restore a MedhaSnapshot, or wipe and re-initialize with --recreate',
    });
  }
}

/** A snapshot file given to `maintain restore` could not be read as an exported MedhaSnapshot. */
export class SnapshotFileError extends CliError {
  readonly code = 'CLI_SNAPSHOT_INVALID';

  constructor(path: string, problem: string) {
    super(`cannot read snapshot ${path}: ${problem}`, {
      context: { path, problem },
      hint: 'maintain backup wrote the file; pass that path back to maintain restore',
    });
  }
}

/** `updater show`/`fork` was given a name no tier resolves. */
export class UpdaterNotFoundError extends CliError {
  readonly code = 'CLI_UPDATER_UNKNOWN';

  constructor(name: string, known: readonly string[]) {
    super(`no updater named '${name}'`, {
      context: { name, known },
      hint: `known updaters: ${known.join(', ')}`,
    });
  }
}

/** `updater fork` refused to overwrite an existing path. */
export class UpdaterForkError extends CliError {
  readonly code = 'CLI_FORK_EXISTS';

  constructor(path: string) {
    super(`${path} already exists`, {
      context: { path },
      hint: 'remove it first, or pass --out to a fresh path',
    });
  }
}

function summarizeDiff(diff: RegistryDiff): string {
  const part = (
    label: string,
    side: { readonly added: readonly string[]; readonly removed: readonly string[] },
  ): string => {
    const bits: string[] = [];
    if (side.added.length > 0) bits.push(`+${side.added.join(',')}`);
    if (side.removed.length > 0) bits.push(`-${side.removed.join(',')}`);
    return bits.length === 0 ? `${label} unchanged` : bits.join(' ');
  };
  return [part('kinds', diff.kinds), part('signals', diff.signals), part('anchors', diff.anchors)]
    .filter((text) => !text.endsWith(' unchanged'))
    .join('; ');
}
