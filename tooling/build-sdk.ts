#!/usr/bin/env bun
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { BunPlugin } from 'bun';

const root = resolve(import.meta.dir, '..');
const medhaDir = join(root, 'medha');
const distDir = join(medhaDir, 'dist');
const typesDir = join(distDir, 'types');

// 1. Clean dist directory
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

// Plugin that replaces bun:sqlite so the bundled ESM entrypoints open a real store in both Bun and
// Node.js. Under Bun it re-exports the native bun:sqlite Database. Under Node it adapts
// node:sqlite's DatabaseSync (Node >= 22.13) to the slice of the bun:sqlite API that
// medha-store/src/sqlite-store.ts uses: new Database(path, opts), run, query().all/get/run,
// transaction and close.
const SHIM_NAMESPACE = 'bun-sqlite-shim';
const bunSqliteShimPlugin: BunPlugin = {
  name: 'bun-sqlite-shim',
  setup(build) {
    build.onResolve({ filter: /^bun:sqlite$/ }, (args) => ({
      path: args.path,
      namespace: SHIM_NAMESPACE,
    }));
    // The shim's own import of bun:sqlite must reach the real module, not the shim again. A literal
    // import('bun:sqlite') here is resolved back into this shim, so it imported itself and exported
    // a null Database (0.8.0-alpha.1). A computed specifier is left for the runtime to resolve.
    build.onLoad({ filter: /.*/, namespace: SHIM_NAMESPACE }, () => ({
      contents: `
let DB;
if (typeof process !== 'undefined' && process.versions?.bun) {
  const bunSqlite = ['bun', 'sqlite'].join(':');
  DB = (await import(bunSqlite)).Database;
} else {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch (cause) {
    DatabaseSync = undefined;
    void cause;
  }
  DB = class NodeSqliteDatabase {
    constructor(path, options) {
      if (DatabaseSync === undefined) {
        throw new Error(
          '@cntxt-labs/medha: a file-backed store needs node:sqlite (Node.js >= 22.13) or Bun; ' +
            'use MedhaClient.memory() on this runtime',
        );
      }
      void options;
      this.db = new DatabaseSync(path);
    }
    run(sql) {
      this.db.exec(sql);
    }
    query(sql) {
      const stmt = this.db.prepare(sql);
      return {
        all: (...params) => stmt.all(...params),
        get: (...params) => stmt.get(...params) ?? null,
        run: (...params) => stmt.run(...params),
      };
    }
    transaction(fn) {
      return (...args) => {
        this.db.exec('BEGIN');
        try {
          const result = fn(...args);
          this.db.exec('COMMIT');
          return result;
        } catch (error) {
          this.db.exec('ROLLBACK');
          throw error;
        }
      };
    }
    close() {
      this.db.close();
    }
  };
}
export const Database = DB;
export default { Database: DB };
`,
      loader: 'js',
    }));
  },
};

// 2. Bundle ESM JavaScript entrypoints
process.stdout.write('Bundling @cntxt-labs/medha entrypoints with Bun...\n');
const indexBuild = await Bun.build({
  entrypoints: [join(medhaDir, 'src', 'index.ts')],
  outdir: distDir,
  target: 'node',
  format: 'esm',
  plugins: [bunSqliteShimPlugin],
  naming: 'index.js',
});
if (!indexBuild.success) {
  process.stderr.write(`Failed to bundle index.ts: ${JSON.stringify(indexBuild.logs)}\n`);
  process.exit(1);
}

const clientBuild = await Bun.build({
  entrypoints: [join(medhaDir, 'src', 'client.ts')],
  outdir: distDir,
  target: 'node',
  format: 'esm',
  plugins: [bunSqliteShimPlugin],
  naming: 'client.js',
});
if (!clientBuild.success) {
  process.stderr.write(`Failed to bundle client.ts: ${JSON.stringify(clientBuild.logs)}\n`);
  process.exit(1);
}

// 3. Emit TypeScript declaration files
process.stdout.write('Emitting TypeScript declaration files with tsc...\n');
const tscProc = Bun.spawnSync(
  [
    'bun',
    'x',
    'tsc',
    '--declaration',
    '--emitDeclarationOnly',
    '--outDir',
    typesDir,
    '--noEmit',
    'false',
    '--rewriteRelativeImportExtensions',
  ],
  {
    cwd: root,
    stdout: 'inherit',
    stderr: 'inherit',
  },
);

if (tscProc.exitCode !== 0) {
  process.stderr.write(`tsc failed to emit declarations with code ${tscProc.exitCode}\n`);
  process.exit(1);
}

// 3b. Make the declaration tree self-contained. tsc emits it from the workspace, so it still names
// the private workspace packages (@cntxt-labs/medha-core, -sync, -store: never published) and keeps
// `.ts` extensions on relative imports. A consumer cannot resolve the former, so every core type
// silently became `any` (0.8.0-alpha.1). Rewrite both, and drop what the SDK does not ship: the CLI
// and tooling trees and test declarations.
const workspacePackages: Record<string, string> = {
  '@cntxt-labs/medha-core': 'medha-core/src/index.js',
  '@cntxt-labs/medha-sync': 'medha-sync/src/index.js',
  '@cntxt-labs/medha-store': 'medha-store/src/index.js',
};
for (const dir of ['cli', 'tooling']) rmSync(join(typesDir, dir), { recursive: true, force: true });
const declarationFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') {
        rmSync(full, { recursive: true, force: true });
        return [];
      }
      return declarationFiles(full);
    }
    if (entry.name.endsWith('.test.d.ts')) {
      rmSync(full);
      return [];
    }
    return entry.name.endsWith('.d.ts') ? [full] : [];
  });
const specifierPattern = /(\bfrom\s+|\bimport\s*\(\s*)(['"])([^'"]+)\2/g;
const unresolved: string[] = [];
for (const file of declarationFiles(typesDir)) {
  const source = readFileSync(file, 'utf8');
  const rewritten = source.replace(
    specifierPattern,
    (match, lead: string, quote: string, spec: string) => {
      let target = spec;
      const workspaceTarget = workspacePackages[spec];
      if (workspaceTarget !== undefined) {
        target = relative(dirname(file), join(typesDir, workspaceTarget)).split(sep).join('/');
        if (!target.startsWith('.')) target = `./${target}`;
      } else if (spec.startsWith('.') && spec.endsWith('.ts') && !spec.endsWith('.d.ts')) {
        target = `${spec.slice(0, -3)}.js`;
      } else if (!spec.startsWith('.') && !spec.startsWith('node:')) {
        unresolved.push(`${relative(typesDir, file)}: ${spec}`);
      }
      return target === spec ? match : `${lead}${quote}${target}${quote}`;
    },
  );
  if (rewritten !== source) writeFileSync(file, rewritten, 'utf8');
}
if (unresolved.length > 0) {
  process.stderr.write(
    `Published declarations import packages the SDK does not depend on:\n  ${unresolved.join('\n  ')}\n`,
  );
  process.exit(1);
}

// 4. Create root entrypoint declarations pointing into types tree
writeFileSync(join(distDir, 'index.d.ts'), "export * from './types/medha/src/index.js';\n", 'utf8');
writeFileSync(
  join(distDir, 'client.d.ts'),
  "export * from './types/medha/src/client.js';\n",
  'utf8',
);

// 5. Copy README and LICENSE into medha/ package
cpSync(join(root, 'README.md'), join(medhaDir, 'README.md'));
cpSync(join(root, 'LICENSE'), join(medhaDir, 'LICENSE'));

process.stdout.write('Successfully built @cntxt-labs/medha SDK distributables in medha/dist\n');
