import type { ArgsDef } from 'citty';

/**
 * The `medha init` argument surface (Loom-ujs3.11.2 command shape, citty). `--dir`, `--store`,
 * `--path`, `--config`, `--backup`, `--recreate`, and `--json` map 1:1 onto InitOptions.
 */
export const initCommandArgs: ArgsDef = {
  dir: {
    type: 'string',
    description: 'Project directory under which the .medha/ home is created. Default: cwd.',
  },
  home: {
    type: 'string',
    description: 'Engine home directory, overriding <dir>/.medha (e.g. an existing .sutra/medha).',
  },
  store: {
    type: 'enum',
    description: 'Store backend.',
    options: ['sqlite', 'file', 'memory'],
    default: 'sqlite',
  },
  path: {
    type: 'string',
    description: 'Store path override: the sqlite db file, or the file-backend document file.',
  },
  config: {
    type: 'string',
    description:
      'registries.json defining kinds / signalSpecs / anchorKinds (additive over built-ins).',
  },
  backup: { type: 'string', description: 'Also write the bootstrap MedhaSnapshot to this path.' },
  recreate: {
    type: 'boolean',
    description: 'Wipe the engine store and re-initialize.',
    default: false,
  },
  json: { type: 'boolean', description: 'Emit the init report as JSON.', default: false },
};

/** Arg surface shared by every read command: --dir and --json. */
export const readCommonArgs: ArgsDef = {
  dir: {
    type: 'string',
    description: 'Project directory whose .medha/ home to open. Default: cwd.',
  },
  home: {
    type: 'string',
    description: 'Engine home directory, overriding <dir>/.medha (e.g. an existing .sutra/medha).',
  },
  json: { type: 'boolean', description: 'Emit the report as JSON.', default: false },
};

/** The three flags that address one entity; --kind/--namespace default for legacy `rules` parity. */
export const readKeyArgs: ArgsDef = {
  namespace: { type: 'string', description: 'Entity namespace. Default: empty.' },
  kind: { type: 'string', description: 'Entity kind. Default: rule.' },
  id: { type: 'string', description: 'Entity id (opaque to Medha, unique per namespace+kind).' },
};

export const listCommandArgs: ArgsDef = {
  ...readCommonArgs,
  kind: { type: 'string', description: 'Filter: entity kind.' },
  status: {
    type: 'string',
    description: 'Filter: lifecycle status (probation|active|trusted|quarantined|retired).',
  },
  namespace: { type: 'string', description: 'Filter: entity namespace.' },
  drifting: { type: 'boolean', description: 'Filter: only entities currently drifting.' },
  limit: { type: 'string', description: 'Page size (default 1000).' },
  cursor: { type: 'string', description: 'Opaque next-page token from a previous --json list.' },
};

export const showCommandArgs: ArgsDef = {
  ...readCommonArgs,
  ...readKeyArgs,
  recent: { type: 'string', description: 'How many recent episodes to include. Default: 10.' },
};

export const statusCommandArgs: ArgsDef = { ...readCommonArgs };

export const driftCommandArgs: ArgsDef = {
  ...readCommonArgs,
  limit: { type: 'string', description: 'Cap the number of drifting entities reported.' },
};

export const paramsCommandArgs: ArgsDef = {
  ...readCommonArgs,
  json: { type: 'boolean', description: 'Emit the report as JSON.', default: false },
};

export const simulateCommandArgs: ArgsDef = {
  ...readCommonArgs,
  ...readKeyArgs,
  signal: { type: 'string', description: 'Signal name to simulate (e.g. APPLY, REJECT_RULE).' },
};

export const explainThresholdCommandArgs: ArgsDef = {
  ...readCommonArgs,
  ...readKeyArgs,
};

/** Arg surface shared by maintenance commands: --dir and --json. */
export const maintainCommonArgs: ArgsDef = {
  dir: {
    type: 'string',
    description: 'Project directory whose .medha/ home to open. Default: cwd.',
  },
  home: {
    type: 'string',
    description: 'Engine home directory, overriding <dir>/.medha (e.g. an existing .sutra/medha).',
  },
  json: { type: 'boolean', description: 'Emit the report as JSON.', default: false },
};

export const maintainPreflightArgs: ArgsDef = { ...maintainCommonArgs };

export const maintainCompactArgs: ArgsDef = {
  ...maintainCommonArgs,
  'older-than': {
    type: 'string',
    description: 'Cutoff in days (e.g. --older-than 30). Default: engine retention config.',
  },
};

export const maintainBackupArgs: ArgsDef = {
  ...maintainCommonArgs,
  path: {
    type: 'positional',
    description: 'Destination file path for the snapshot JSON.',
    required: true,
  },
};

export const maintainRestoreArgs: ArgsDef = {
  ...maintainCommonArgs,
  path: {
    type: 'positional',
    description: 'Source snapshot JSON file to restore.',
    required: true,
  },
};

/** Arg surface shared by updater commands: --dir and --json. */
export const updaterCommonArgs: ArgsDef = {
  dir: {
    type: 'string',
    description: 'Project directory whose .medha/ home to open. Default: cwd.',
  },
  home: {
    type: 'string',
    description: 'Engine home directory, overriding <dir>/.medha (e.g. an existing .sutra/medha).',
  },
  json: { type: 'boolean', description: 'Emit the report as JSON.', default: false },
};

export const updaterListArgs: ArgsDef = { ...updaterCommonArgs };

export const updaterShowArgs: ArgsDef = {
  ...updaterCommonArgs,
  name: {
    type: 'positional',
    description: 'Name of the weight updater to inspect.',
    required: true,
  },
};

export const updaterForkArgs: ArgsDef = {
  ...updaterCommonArgs,
  name: {
    type: 'positional',
    description: 'Name of the weight updater to fork.',
    required: true,
  },
  out: {
    type: 'string',
    description: 'Destination file path for the scaffolded updater template.',
  },
};

export const mcpCommandArgs: ArgsDef = {
  dir: {
    type: 'string',
    description: 'Project directory whose .medha/ home to open. Default: cwd.',
  },
  home: {
    type: 'string',
    description: 'Engine home directory, overriding <dir>/.medha (e.g. an existing .sutra/medha).',
  },
};

export const syncStatusArgs: ArgsDef = {
  ...readCommonArgs,
  ref: {
    type: 'string',
    description: 'Git ref to synchronize (default: refs/sutra/medha/memory).',
  },
  remote: { type: 'string', description: 'Git remote to synchronize with (default: origin).' },
  file: { type: 'string', description: 'File path for file-based synchronization.' },
};

export const syncPullArgs: ArgsDef = {
  ...readCommonArgs,
  ref: { type: 'string', description: 'Git ref to pull from (default: refs/sutra/medha/memory).' },
  remote: { type: 'string', description: 'Git remote to pull from (default: origin).' },
  file: { type: 'string', description: 'File path for file-based synchronization.' },
  'auto-import-registries': {
    type: 'boolean',
    description:
      'Automatically import and merge missing custom kinds/signals from incoming sync into local config.json.',
  },
};

export const syncPushArgs: ArgsDef = {
  ...readCommonArgs,
  ref: { type: 'string', description: 'Git ref to push to (default: refs/sutra/medha/memory).' },
  remote: { type: 'string', description: 'Git remote to push to (default: origin).' },
  file: { type: 'string', description: 'File path for file-based synchronization.' },
};

export const recordCommandArgs: ArgsDef = {
  ...readCommonArgs,
  ...readKeyArgs,
  signal: { type: 'string', description: 'Signal to record (e.g. APPLY, REJECT_RULE, SKIP).' },
  updater: { type: 'string', description: 'Weight updater name to use.' },
  ensure: { type: 'boolean', description: 'Create the entity if it does not exist.' },
  author: { type: 'string', description: 'Author or agent identifier recording this evidence.' },
  at: {
    type: 'string',
    description: 'Historical timestamp (ISO 8601 string or epoch ms) for backfilling.',
  },
  note: { type: 'string', description: 'Natural language rationale or note.' },
};

export const guardCommandArgs: ArgsDef = {
  ...readCommonArgs,
  ...readKeyArgs,
  ok: { type: 'boolean', description: 'The guard passed.' },
  fail: { type: 'boolean', description: 'The guard failed.' },
  guard: { type: 'string', description: 'Guard kind, e.g. harness, review, audit.' },
  author: {
    type: 'string',
    description: 'Author or agent identifier recording this guard report.',
  },
  at: {
    type: 'string',
    description: 'Historical timestamp (ISO 8601 string or epoch ms) for backfilling.',
  },
  note: { type: 'string', description: 'Natural language rationale or note.' },
};

export const proposeCommandArgs: ArgsDef = {
  ...readCommonArgs,
  ...readKeyArgs,
  source: { type: 'string', description: 'Source of the proposal (miner name or file path).' },
  text: { type: 'string', description: 'Optional text of the proposal.' },
  evidence: { type: 'string', description: 'Comma-separated evidence refs (commit SHAs, paths).' },
  author: { type: 'string', description: 'Author or agent identifier submitting this proposal.' },
  at: {
    type: 'string',
    description: 'Historical timestamp (ISO 8601 string or epoch ms) for backfilling.',
  },
  note: { type: 'string', description: 'Natural language rationale or note.' },
};

export const retractCommandArgs: ArgsDef = {
  ...readCommonArgs,
  seq: { type: 'string', description: 'Episode sequence number to retract.', required: true },
  reason: { type: 'string', description: 'Reason for the retraction.', required: true },
  author: { type: 'string', description: 'Author or agent identifier recording this retraction.' },
  at: {
    type: 'string',
    description: 'Historical timestamp (ISO 8601 string or epoch ms) for backfilling.',
  },
};

export const removeEpisodeCommandArgs: ArgsDef = {
  ...maintainCommonArgs,
  seq: { type: 'string', description: 'Episode sequence number to remove.', required: true },
};

export const packCommandArgs: ArgsDef = {
  ...readCommonArgs,
  budget: { type: 'string', description: 'Token budget cap (e.g. --budget 2000).' },
  kind: { type: 'string', description: 'Filter: entity kind (default: rule).' },
  namespace: { type: 'string', description: 'Filter: entity namespace.' },
  exploration: {
    type: 'string',
    description: 'Budget ratio reserved for probation exploration (default: 0.15).',
  },
  format: {
    type: 'string',
    description: 'Output format: markdown | compact | json (default: markdown).',
  },
  seed: { type: 'string', description: 'Random seed for reproducible exploration sampling.' },
};

export const uiCommandArgs: ArgsDef = {
  dir: {
    type: 'string',
    description: 'Project directory whose .medha/ home to open. Default: cwd.',
  },
  home: {
    type: 'string',
    description: 'Engine home directory, overriding <dir>/.medha (e.g. an existing .sutra/medha).',
  },
  port: {
    type: 'string',
    description: 'Port to bind the dashboard server (default: 8448).',
  },
  host: {
    type: 'string',
    description: 'Host to bind the dashboard server (default: 127.0.0.1).',
  },
  open: {
    type: 'boolean',
    description: 'Open the dashboard in the default browser on launch.',
  },
};

export const reportCommandArgs: ArgsDef = {
  ...readCommonArgs,
  out: {
    type: 'string',
    description: 'Output HTML file path (default: medha-report.html).',
  },
};
