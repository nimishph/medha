#!/usr/bin/env bun
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BunPlugin } from 'bun';

const root = resolve(import.meta.dir, '..');
const medhaDir = join(root, 'medha');
const distDir = join(medhaDir, 'dist');
const typesDir = join(distDir, 'types');

// 1. Clean dist directory
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

// Plugin to shim bun:sqlite so the bundled ESM entrypoints load cleanly in both Bun and Node.js
const bunSqliteShimPlugin: BunPlugin = {
  name: 'bun-sqlite-shim',
  setup(build) {
    build.onResolve({ filter: /^bun:sqlite$/ }, (args) => ({
      path: args.path,
      namespace: 'bun-sqlite-shim',
    }));
    build.onLoad({ filter: /.*/, namespace: 'bun-sqlite-shim' }, () => ({
      contents: `
let DB = null;
try {
  if (typeof process !== 'undefined' && process.versions?.bun) {
    const mod = await import('bun:sqlite');
    DB = mod.Database;
  }
} catch (e) {
  void e;
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
