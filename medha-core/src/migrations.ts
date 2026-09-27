/**
 * Generic ordered migration pipeline for versioned schemas, snapshots, and documents (§6.4, §7.2).
 */

import { InvalidArgumentError, SchemaVersionError } from './errors.ts';

export interface MigrationStep<T = unknown> {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly description: string;
  migrate(doc: T): T;
}

export interface MigrationResult<TDoc> {
  readonly doc: TDoc;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly migrated: boolean;
  readonly steps: readonly string[];
}

/**
 * Executes a strictly ordered sequence of contiguous migration steps (e.g. 0 -> 1 -> 2).
 */
export class MigrationPipeline<TDoc extends Record<string, unknown>> {
  readonly currentVersion: number;
  private readonly steps: readonly MigrationStep<unknown>[];

  constructor(currentVersion: number, steps: readonly MigrationStep<unknown>[] = []) {
    if (!Number.isInteger(currentVersion) || currentVersion < 0) {
      throw new InvalidArgumentError('currentVersion', 'a non-negative integer', currentVersion);
    }
    this.currentVersion = currentVersion;
    const sorted = [...steps].sort((a, b) => a.fromVersion - b.fromVersion);
    for (let i = 0; i < sorted.length; i++) {
      const step = sorted[i] as MigrationStep<unknown>;
      if (step.toVersion <= step.fromVersion) {
        throw new InvalidArgumentError(
          `steps[${i}].toVersion`,
          `greater than fromVersion (${step.fromVersion})`,
          step.toVersion,
        );
      }
      if (i > 0 && step.fromVersion !== (sorted[i - 1] as MigrationStep<unknown>).toVersion) {
        throw new InvalidArgumentError(
          `steps[${i}].fromVersion`,
          `contiguous with previous toVersion (${(sorted[i - 1] as MigrationStep<unknown>).toVersion})`,
          step.fromVersion,
        );
      }
    }
    this.steps = sorted;
  }

  migrate(
    raw: unknown,
    extractVersion: (obj: Record<string, unknown>) => number,
  ): MigrationResult<TDoc> {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new InvalidArgumentError('raw', 'a non-null document object', raw);
    }

    const obj = raw as Record<string, unknown>;
    const sourceVersion = extractVersion(obj);

    if (
      typeof sourceVersion !== 'number' ||
      !Number.isInteger(sourceVersion) ||
      sourceVersion < 0
    ) {
      throw new InvalidArgumentError(
        'sourceVersion',
        'a non-negative integer version',
        sourceVersion,
      );
    }

    if (sourceVersion > this.currentVersion) {
      throw new SchemaVersionError(this.currentVersion, sourceVersion, {
        hint: `Document format version ${sourceVersion} is newer than supported version ${this.currentVersion}. Please upgrade your Medha package.`,
      });
    }

    if (sourceVersion === this.currentVersion) {
      return {
        doc: obj as unknown as TDoc,
        fromVersion: sourceVersion,
        toVersion: this.currentVersion,
        migrated: false,
        steps: [],
      };
    }

    let current = { ...obj };
    let curVer = sourceVersion;
    const executedSteps: string[] = [];

    while (curVer < this.currentVersion) {
      const step = this.steps.find((s) => s.fromVersion === curVer);
      if (!step) {
        throw new SchemaVersionError(this.currentVersion, curVer, {
          hint: `No migration step available from version ${curVer} towards ${this.currentVersion}.`,
        });
      }
      current = step.migrate(current) as Record<string, unknown>;
      executedSteps.push(step.description);
      curVer = step.toVersion;
    }

    return {
      doc: current as unknown as TDoc,
      fromVersion: sourceVersion,
      toVersion: this.currentVersion,
      migrated: true,
      steps: executedSteps,
    };
  }
}
