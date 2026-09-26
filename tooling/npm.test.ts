import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { MAIN_PACKAGE, PLATFORMS, platformPackage } from './platforms.ts';

const root = resolve(import.meta.dir, '..');
const manifest = (folder: string) =>
  JSON.parse(readFileSync(join(root, folder, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
    private?: boolean;
    license?: string;
    author?: { name: string };
    bin?: Record<string, string>;
    files?: string[];
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    publishConfig?: { access: string };
  };

const launcher = createRequire(import.meta.url)('../cli/bin/medha.cjs') as {
  SUPPORTED: string[];
  platformPackage(platform: string, cpu: string): string | undefined;
  locate(
    platform: string,
    cpu: string,
    resolve: (specifier: string) => string,
  ): { program?: string; problem?: string };
};

/** What Node throws when a package is not installed. */
class ModuleNotFound extends Error {
  readonly code = 'MODULE_NOT_FOUND';
}

describe('what is published', () => {
  const cli = manifest('cli');

  test('only the command is public, under the owner named as author, and it is MIT', () => {
    expect(cli.name).toBe(MAIN_PACKAGE);
    expect(cli.private).toBeUndefined();
    expect(cli.publishConfig?.access).toBe('public');
    expect(cli.license).toBe('MIT');
    expect(cli.author?.name).toBe('nimishph');
    expect(cli.bin).toEqual({ medha: 'bin/medha.cjs' });
    expect(cli.files).toEqual(['bin', 'SKILL.md', 'README.md', 'LICENSE']);
    // Everything else is built into the program, so installing it pulls in nothing.
    expect(cli.dependencies).toBeUndefined();

    for (const folder of readdirSync(root, { withFileTypes: true })) {
      if (!folder.isDirectory() || folder.name === 'cli') continue;
      try {
        expect(manifest(folder.name).private).toBe(true);
      } catch (failure) {
        // Folders without a manifest (dist, .github, node_modules) are not packages.
        if ((failure as { code?: string }).code !== 'ENOENT') throw failure;
      }
    }
  });

  test('it installs exactly one program per platform, at its own version', () => {
    expect(Object.keys(cli.optionalDependencies ?? {}).sort()).toEqual(
      PLATFORMS.map(platformPackage).sort(),
    );
    for (const version of Object.values(cli.optionalDependencies ?? {})) {
      expect(version).toBe(cli.version);
    }
  });

  test('every package carries the version the release tag is checked against', () => {
    const versions = new Set(
      ['medha-core', 'medha-store', 'medha-sync', 'medha', 'cli'].map((f) => manifest(f).version),
    );
    expect([...versions]).toEqual([cli.version]);
  });
});

describe('the launcher', () => {
  test('knows the same platforms the build does', () => {
    expect([...launcher.SUPPORTED].sort()).toEqual(PLATFORMS.map((p) => `${p.os}-${p.cpu}`).sort());
    for (const p of PLATFORMS) {
      expect(launcher.platformPackage(p.os, p.cpu)).toBe(platformPackage(p));
    }
  });

  test('finds the program in the platform package', () => {
    const found = launcher.locate('linux', 'x64', (specifier) => `/modules/${specifier}`);
    expect(found.program).toBe('/modules/@cntxt-labs/medha-linux-x64/bin/medha');
    const windows = launcher.locate('win32', 'x64', (specifier) => `/modules/${specifier}`);
    expect(windows.program).toBe('/modules/@cntxt-labs/medha-win32-x64/bin/medha.exe');
  });

  test('says what is wrong on an unsupported platform and when the package is missing', () => {
    const unsupported = launcher.locate('freebsd', 'x64', () => '');
    expect(unsupported.problem).toContain('no build for freebsd on x64');
    expect(unsupported.problem).toContain('linux-x64');

    const missing = launcher.locate('linux', 'x64', () => {
      throw new ModuleNotFound('Cannot find module');
    });
    expect(missing.problem).toContain('@cntxt-labs/medha-linux-x64 package is not installed');
    expect(missing.problem).toContain('MODULE_NOT_FOUND');
    expect(missing.problem).not.toContain('undefined');
  });
});
