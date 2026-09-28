import { afterAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { programMode, TYPEFLAG, ustarHeader } from './npm-tarball.ts';
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
  makeExecutable(program: string): boolean;
  isPermissionFailure(error: { code?: string } | undefined | null): boolean;
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

describe('recovering a program that lost its executable bit (nimishph/medha#1)', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'medha-chmod-'));
  afterAll(() => rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  test('it sets the bit, and says so', () => {
    const program = join(sandbox, 'medha');
    writeFileSync(program, '#!/bin/sh\necho hi\n');
    // Start from "definitely not executable", the state a permission-stripping install leaves.
    chmodSync(program, 0o644);
    expect(launcher.makeExecutable(program)).toBe(true);
    if (process.platform !== 'win32') {
      // The bit is the whole point, so check it rather than trusting the return value.
      expect(statSync(program).mode & 0o111).not.toBe(0);
    }
  });

  test('it reports failure instead of throwing when the program cannot be reached', () => {
    // A read-only or missing path must not turn into an unhandled exception at startup.
    expect(launcher.makeExecutable(join(sandbox, 'not-here'))).toBe(false);
  });

  test('it only retries on a permission failure, not on any error at all', () => {
    expect(launcher.isPermissionFailure({ code: 'EACCES' })).toBe(true);
    // ENOEXEC, ENOENT, EPERM and a clean run are different problems with different fixes.
    expect(launcher.isPermissionFailure({ code: 'ENOENT' })).toBe(false);
    expect(launcher.isPermissionFailure({ code: 'EPERM' })).toBe(false);
    expect(launcher.isPermissionFailure(undefined)).toBe(false);
    expect(launcher.isPermissionFailure(null)).toBe(false);
  });
});

describe('reading the mode back out of a packed tarball (nimishph/medha#1)', () => {
  /**
   * A tarball of the given entries, each followed by the data blocks its size calls for, then the
   * two empty blocks that end an archive. The data blocks are sized deliberately: a parser that
   * ignores the size field desynchronises here rather than passing by luck.
   */
  const tarball = (entries: readonly { name: string; mode: number; size?: number }[]) => {
    const sizes = entries.map((entry) => Math.ceil((entry.size ?? 0) / 512) * 512);
    const total = entries.length * 512 + sizes.reduce((a, b) => a + b, 0) + 1024;
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const [i, entry] of entries.entries()) {
      bytes.set(ustarHeader(entry.name, entry.mode, entry.size ?? 0), at);
      at += 512 + (sizes[i] as number);
    }
    return bytes;
  };
  /** A header with its typeflag set to '5', which is how tar records a directory. */
  const asDirectory = (header: Uint8Array) => {
    const copy = new Uint8Array(header);
    copy[TYPEFLAG] = '5'.charCodeAt(0);
    return copy;
  };

  test('it sees 0755 in a correctly packed tarball', () => {
    const packed = tarball([
      { name: 'package/package.json', mode: 0o644, size: 1073 },
      // Sized to span more than one data block, so the parser has to honour the size field.
      { name: 'package/bin/medha', mode: 0o755, size: 700 },
    ]);
    expect(programMode(packed)).toBe(0o755);
  });

  test('it sees 0644 in the tarball that shipped the bug, rather than passing vacuously', () => {
    // The failure this guards against is a guard that stops matching and reports success forever.
    const mode = programMode(tarball([{ name: 'package/bin/medha', mode: 0o644, size: 700 }]));
    expect(mode).toBe(0o644);
    expect(mode).not.toBe(0o755);
  });

  test('it finds the program whatever order the entries are in', () => {
    const packed = tarball([
      { name: 'package/bin/medha', mode: 0o755 },
      { name: 'package/package.json', mode: 0o644 },
    ]);
    expect(programMode(packed)).toBe(0o755);
  });

  test('it reads a gzipped tarball, which is the shape npm actually publishes', () => {
    // Uncompressed bytes only: parsing those while npm ships .tgz is a guard that never fires.
    const plain = tarball([{ name: 'package/bin/medha', mode: 0o755 }]);
    expect(Bun.gzipSync(plain).byteLength).toBeGreaterThan(0);
    expect(programMode(new Uint8Array(Bun.gzipSync(plain)))).toBe(0o755);
    expect(
      programMode(
        new Uint8Array(Bun.gzipSync(tarball([{ name: 'package/bin/medha', mode: 0o644 }]))),
      ),
    ).toBe(0o644);
  });

  test('it reports nothing rather than guessing when the tarball holds no program', () => {
    expect(programMode(new Uint8Array(0))).toBeUndefined();
    expect(programMode(tarball([{ name: 'package/package.json', mode: 0o644 }]))).toBeUndefined();
    // A *directory* called bin/ is not the program and must not be mistaken for one.
    const onlyDir = asDirectory(ustarHeader('package/bin/', 0o755));
    const archive = new Uint8Array(512 + 1024);
    archive.set(onlyDir, 0);
    expect(programMode(archive)).toBeUndefined();
  });
});
