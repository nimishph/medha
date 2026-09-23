/**
 * Unit tests for MemorySnapshot schema versioning and migration (§7.2).
 */

import { describe, expect, it } from 'bun:test';
import {
  CURRENT_MEMORY_SCHEMA_VERSION,
  InvalidArgumentError,
  type MemorySnapshotV1,
  migrateSnapshot,
  SchemaVersionError,
  serializeSnapshot,
} from '../index.ts';

describe('MemorySnapshot schema versioning & migration', () => {
  it('accepts and preserves a valid V1 snapshot', () => {
    const v1: MemorySnapshotV1 = {
      schemaVersion: 1,
      asOf: 1727100000000,
      entities: [
        {
          key: { namespace: '', kind: 'rule', id: 'rule-1' },
          evidence: { k: 5, n: 6, contextRejects: 0 },
          ema: { mu: 0.8, theta0: 0.5, updatedAt: 1727100000000 },
          guard: { kind: 'ast', lastOk: true, lastOkAt: 1727100000000 },
          anchors: [{ kind: 'git-head', value: 'c0ffee' }],
          status: 'trusted',
          override: null,
          retiredAt: null,
          restoredAt: null,
          updater: 'ema',
          createdAt: 1727000000000,
          lastSignalAt: 1727100000000,
        },
      ],
      meta: { lastSweep: '1727100000000' },
    };

    const migrated = migrateSnapshot(v1);
    expect(migrated.schemaVersion).toBe(CURRENT_MEMORY_SCHEMA_VERSION);
    expect(migrated.asOf).toBe(1727100000000);
    expect(migrated.entities).toHaveLength(1);
    expect(migrated.entities[0]?.key.id).toBe('rule-1');
    expect(migrated.meta?.lastSweep).toBe('1727100000000');
  });

  it('migrates legacy V0 snapshot without explicit schemaVersion to V1', () => {
    const v0 = {
      last_state_update: 1727050000000,
      entities: [
        {
          key: { namespace: '', kind: 'tool', id: 'tool-a' },
          evidence: { k: 2, n: 3, contextRejects: 0 },
          ema: { mu: 0.6, theta0: 0.5, updatedAt: 1727050000000 },
          guard: { kind: 'smoke', lastOk: null },
          anchors: [],
          status: 'probation',
          override: null,
          retiredAt: null,
          restoredAt: null,
          updater: 'ema',
          createdAt: 1727000000000,
          lastSignalAt: 1727050000000,
        },
      ],
    };

    const migrated = migrateSnapshot(v0);
    expect(migrated.schemaVersion).toBe(1);
    expect(migrated.asOf).toBe(1727050000000);
    expect(migrated.entities).toHaveLength(1);
    expect(migrated.entities[0]?.key.id).toBe('tool-a');
  });

  it('migrates map-shaped legacy rules to entities array in V1', () => {
    const legacy = {
      version: 1,
      rules: {
        'rule-x': {
          key: { namespace: '', kind: 'rule', id: 'rule-x' },
          evidence: { k: 1, n: 1, contextRejects: 0 },
          ema: { mu: 0.55, theta0: 0.5, updatedAt: 1000 },
          guard: { kind: 'test', lastOk: true },
          anchors: [],
          status: 'probation',
          override: null,
          retiredAt: null,
          restoredAt: null,
          updater: 'ema',
          createdAt: 1000,
          lastSignalAt: 1000,
        },
      },
    };

    const migrated = migrateSnapshot(legacy);
    expect(migrated.schemaVersion).toBe(1);
    expect(migrated.entities).toHaveLength(1);
    expect(migrated.entities[0]?.key.id).toBe('rule-x');
  });

  it('rejects future schema versions with typed SchemaVersionError', () => {
    const future = {
      schemaVersion: 99,
      entities: [],
    };

    expect(() => migrateSnapshot(future)).toThrow(SchemaVersionError);
  });

  it('rejects invalid non-object input', () => {
    expect(() => migrateSnapshot(null)).toThrow(InvalidArgumentError);
    expect(() => migrateSnapshot('not-an-object')).toThrow(InvalidArgumentError);
  });

  it('serializes snapshot deterministically with trailing newline', () => {
    const snapshot: MemorySnapshotV1 = {
      schemaVersion: 1,
      asOf: 1000,
      entities: [],
    };

    const serialized = serializeSnapshot(snapshot);
    expect(serialized.endsWith('\n')).toBe(true);
    expect(JSON.parse(serialized).schemaVersion).toBe(1);
  });
});
