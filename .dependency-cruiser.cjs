// Boundaries for the sage packages. The graph is one-way:
// sage -> { core, store, sync }; store -> core; sync -> core. Cross-package imports must go through
// a package's public entry point (src/index.ts), never into its internals. See the SAGE-LIBRARY-SPEC
// §10 (migration) for why this surface exists.

/** package directory -> the only workspace packages it may import. */
const ALLOWED = {
  'medha-core': [],
  'medha-store': ['medha-core'],
  'medha-sync': ['medha-core'],
  // Engine facade (planes, sweep, exploration helper), CLI and MCP composition root.
  medha: ['medha-core', 'medha-store', 'medha-sync'],
  // The `medha` command line: init today, the read/write/maintenance planes as they land.
  cli: ['medha', 'medha-core', 'medha-store'],
};

const names = Object.keys(ALLOWED);

const dependencyRules = names.map((pkg) => ({
  name: `${pkg}-allowed-deps`,
  severity: 'error',
  comment: `${pkg} may only depend on: ${ALLOWED[pkg].join(', ') || '(nothing)'}`,
  from: { path: `^${pkg}/src` },
  to: {
    path: `^(${names.filter((n) => n !== pkg && !ALLOWED[pkg].includes(n)).join('|')})/src`,
  },
}));

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    ...dependencyRules,
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'public-entry-only',
      severity: 'error',
      comment: 'Import another package through its index.ts, not its internals.',
      from: { path: `^(${names.join('|')})/src` },
      to: {
        path: String.raw`^(${names.join('|')})/src/(?!index\.ts$)`,
        pathNot: ['^$1/src'],
      },
    },
    {
      name: 'no-import-from-host-repo',
      severity: 'error',
      comment: 'packages/ must stay extractable: nothing may reach above this directory.',
      from: { path: '^[^/]+/src' },
      to: { path: String.raw`^\.\./` },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
  },
};
