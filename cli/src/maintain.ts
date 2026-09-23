import { readFileSync } from 'node:fs';
import type { CompactionReport, MedhaSnapshot, PreflightReport } from '@cntxt-labs/medha';
import { InvalidArgumentError } from '@cntxt-labs/medha-core';
import type { Environment } from './environment.ts';
import { SnapshotFileError } from './errors.ts';
import { writeSnapshot } from './layout.ts';
import { openHome } from './open.ts';
import { positiveInt } from './read.ts';

/**
 * The `maintain` plane (§ 9.1): preflight (reporting, never throwing), compact (fold an old range),
 * backup (export a portable snapshot), restore (import one back, atomically). These mirror the
 * engine's maintenance methods on the second home the CLI keeps; every command here can run
 * headless (no TTY), which is what the acceptance gates assert.
 */

export interface MaintainCommonOptions {
  readonly dir?: string | undefined;
  readonly home?: string | undefined;
}

export interface MaintainPreflightOptions extends MaintainCommonOptions {}

export interface MaintainPreflightReport {
  readonly home: string;
  readonly asOf: number;
  readonly preflight: PreflightReport;
}

export async function runMaintainPreflight(
  options: MaintainPreflightOptions,
  environment: Environment,
): Promise<MaintainPreflightReport> {
  const opened = openHome(options.dir ?? environment.cwd, options.home);
  try {
    const now = environment.now();
    const preflight = await opened.engine.preflight({ now });
    if (preflight.status === 'corrupt') {
      environment.exitCode = 1;
    }
    return { home: opened.home, asOf: now, preflight };
  } finally {
    await opened.engine.close();
  }
}

export interface MaintainCompactOptions extends MaintainCommonOptions {
  readonly olderThan?: string | undefined;
}

export interface MaintainCompactReport {
  readonly home: string;
  readonly asOf: number;
  readonly report: CompactionReport;
}

export async function runMaintainCompact(
  options: MaintainCompactOptions,
  environment: Environment,
): Promise<MaintainCompactReport> {
  const opened = openHome(options.dir ?? environment.cwd, options.home);
  try {
    const now = environment.now();
    const report = await opened.engine.compact(
      { now },
      options.olderThan === undefined
        ? {}
        : { olderThan: positiveInt('--older-than', options.olderThan) },
    );
    return { home: opened.home, asOf: now, report };
  } finally {
    await opened.engine.close();
  }
}

export interface MaintainBackupOptions extends MaintainCommonOptions {
  readonly path?: string | undefined;
}

export interface MaintainBackupReport {
  readonly home: string;
  readonly asOf: number;
  readonly path: string;
  readonly snapshot: MedhaSnapshot;
}

export async function runMaintainBackup(
  options: MaintainBackupOptions,
  environment: Environment,
): Promise<MaintainBackupReport> {
  if (!options.path || typeof options.path !== 'string') {
    throw new InvalidArgumentError('path', 'a non-empty string path', options.path);
  }
  const opened = openHome(options.dir ?? environment.cwd, options.home);
  try {
    const now = environment.now();
    const { snapshot } = await opened.engine.backup({ now });
    writeSnapshot(options.path, snapshot);
    return { home: opened.home, asOf: now, path: options.path, snapshot };
  } finally {
    await opened.engine.close();
  }
}

export interface MaintainRestoreOptions extends MaintainCommonOptions {
  readonly path?: string | undefined;
}

export interface MaintainRestoreReport {
  readonly home: string;
  readonly asOf: number;
  readonly path: string;
  readonly restored: { readonly from: number; readonly to: number };
}

export async function runMaintainRestore(
  options: MaintainRestoreOptions,
  environment: Environment,
): Promise<MaintainRestoreReport> {
  if (!options.path || typeof options.path !== 'string') {
    throw new InvalidArgumentError('path', 'a non-empty string path', options.path);
  }
  const snapshot = readSnapshotFile(options.path);
  const opened = openHome(options.dir ?? environment.cwd, options.home);
  try {
    const { restored } = await opened.engine.restore(snapshot);
    const now = environment.now();
    return { home: opened.home, asOf: now, path: options.path, restored };
  } finally {
    await opened.engine.close();
  }
}

export function readSnapshotFile(path: string): MedhaSnapshot {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (err) {
    throw new SnapshotFileError(path, err instanceof Error ? err.message : String(err));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new SnapshotFileError(
      path,
      `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new SnapshotFileError(path, 'expected a JSON object');
  }
  const snapObj =
    'snapshot' in parsed && parsed.snapshot && typeof parsed.snapshot === 'object'
      ? parsed.snapshot
      : parsed;
  const cand = snapObj as Record<string, unknown>;
  if (cand.format !== 'sutras.medha/v1') {
    throw new SnapshotFileError(
      path,
      `unsupported snapshot format: '${cand.format}', expected 'sutras.medha/v1'`,
    );
  }
  if (!Array.isArray(cand.episodes)) {
    throw new SnapshotFileError(path, 'snapshot missing episodes array');
  }
  return cand as unknown as MedhaSnapshot;
}
