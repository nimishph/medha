/**
 * Unit tests for generic MigrationPipeline (§6.4, §7.2).
 */

import { describe, expect, it } from 'bun:test';
import {
  InvalidArgumentError,
  MigrationPipeline,
  type MigrationStep,
  SchemaVersionError,
} from '../index.ts';

describe('MigrationPipeline', () => {
  it('validates pipeline contiguity on construction', () => {
    // Gap: step 0->1, step 2->3 (missing 1->2)
    const gapSteps: MigrationStep[] = [
      { fromVersion: 0, toVersion: 1, description: 'v0->v1', migrate: (d) => d },
      { fromVersion: 2, toVersion: 3, description: 'v2->v3', migrate: (d) => d },
    ];
    expect(() => new MigrationPipeline(3, gapSteps)).toThrow(InvalidArgumentError);

    // Non-increasing step: fromVersion 1 toVersion 1
    const invalidSteps: MigrationStep[] = [
      { fromVersion: 1, toVersion: 1, description: 'loop', migrate: (d) => d },
    ];
    expect(() => new MigrationPipeline(1, invalidSteps)).toThrow(InvalidArgumentError);
  });

  it('passes through documents already at currentVersion without mutation', () => {
    const pipeline = new MigrationPipeline<{ version: number; count: number }>(2, [
      { fromVersion: 0, toVersion: 1, description: 'step 1', migrate: (d) => d },
      { fromVersion: 1, toVersion: 2, description: 'step 2', migrate: (d) => d },
    ]);

    const currentDoc = { version: 2, count: 42 };
    const result = pipeline.migrate(currentDoc, (d) => d.version as number);

    expect(result.migrated).toBe(false);
    expect(result.fromVersion).toBe(2);
    expect(result.toVersion).toBe(2);
    expect(result.doc).toEqual(currentDoc);
    expect(result.steps).toHaveLength(0);
  });

  it('runs ordered migrations sequentially from older version', () => {
    interface Doc {
      [key: string]: unknown;
      version: number;
      tags?: string[];
      counter?: number;
    }

    const step0to1: MigrationStep<Doc> = {
      fromVersion: 0,
      toVersion: 1,
      description: 'Add default tags array',
      migrate: (doc) => ({
        ...doc,
        version: 1,
        tags: doc.tags ?? ['default'],
      }),
    };

    const step1to2: MigrationStep<Doc> = {
      fromVersion: 1,
      toVersion: 2,
      description: 'Add initial counter',
      migrate: (doc) => ({
        ...doc,
        version: 2,
        counter: (doc.tags?.length ?? 0) * 10,
      }),
    };

    const pipeline = new MigrationPipeline<Doc>(2, [step0to1, step1to2]);

    const oldDoc: Doc = { version: 0 };
    const result = pipeline.migrate(oldDoc, (d) => d.version as number);

    expect(result.migrated).toBe(true);
    expect(result.fromVersion).toBe(0);
    expect(result.toVersion).toBe(2);
    expect(result.doc.version).toBe(2);
    expect(result.doc.tags).toEqual(['default']);
    expect(result.doc.counter).toBe(10);
    expect(result.steps).toEqual(['Add default tags array', 'Add initial counter']);
  });

  it('rejects documents with version higher than currentVersion with SchemaVersionError', () => {
    const pipeline = new MigrationPipeline<{ version: number }>(1, [
      { fromVersion: 0, toVersion: 1, description: 'v0->v1', migrate: (d) => d },
    ]);

    expect(() => pipeline.migrate({ version: 99 }, (d) => d.version as number)).toThrow(
      SchemaVersionError,
    );
  });

  it('rejects invalid inputs', () => {
    const pipeline = new MigrationPipeline(1);
    expect(() => pipeline.migrate(null, () => 0)).toThrow(InvalidArgumentError);
    expect(() => pipeline.migrate('string', () => 0)).toThrow(InvalidArgumentError);
    expect(() => pipeline.migrate([], () => 0)).toThrow(InvalidArgumentError);
    expect(() => pipeline.migrate({}, () => -1)).toThrow(InvalidArgumentError);
    expect(() => pipeline.migrate({}, () => 1.5)).toThrow(InvalidArgumentError);
  });
});
