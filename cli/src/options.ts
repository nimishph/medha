import type { ArgsDef } from 'citty';

/**
 * The `sage init` argument surface (Loom-ujs3.11.2 command shape, citty). `--dir`, `--store`,
 * `--path`, `--config`, `--backup`, `--recreate`, and `--json` map 1:1 onto InitOptions.
 */
export const initCommandArgs: ArgsDef = {
  dir: {
    type: 'string',
    description: 'Project directory under which .sutra/sage/ is created. Default: cwd.',
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
  backup: { type: 'string', description: 'Also write the bootstrap SageSnapshot to this path.' },
  recreate: {
    type: 'boolean',
    description: 'Wipe the engine store and re-initialize.',
    default: false,
  },
  json: { type: 'boolean', description: 'Emit the init report as JSON.', default: false },
};
