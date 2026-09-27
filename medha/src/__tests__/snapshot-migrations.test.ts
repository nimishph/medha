/**
 * Integration and unit tests for versioned store snapshots and ordered migrations (§6.4, §9).
 * Tests migration pipeline against historical and synthetic fixtures.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SQLiteStore } from '@cntxt-labs/medha-store';
import {
  CURRENT_SNAPSHOT_FORMAT_VERSION,
  extractStoreSnapshotVersion,
  Medha,
  migrateStoreSnapshot,
  SchemaVersionError,
  SNAPSHOT_FORMAT,
} from '../index.ts';

const fixturesDir = join(import.meta.dir, 'fixtures');

function loadFixture(filename: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, filename), 'utf8'));
}

describe('Store snapshot versioning and ordered migrations', () => {
  it('extracts format versions accurately across all format variations', () => {
    expect(extractStoreSnapshotVersion({ formatVersion: 1 })).toBe(1);
    expect(extractStoreSnapshotVersion({ format: 'sutras.medha/v1' })).toBe(1);
    expect(extractStoreSnapshotVersion({ format: 'sutras.sage/v1' })).toBe(1);
    expect(extractStoreSnapshotVersion({ format: 'sutras.medha/v2', formatVersion: 2 })).toBe(2);
    expect(extractStoreSnapshotVersion({ schemaVersion: 1 })).toBe(1);
    expect(extractStoreSnapshotVersion({ episodes: [] })).toBe(0);
    expect(extractStoreSnapshotVersion({ snapshot: { format: 'sutras.medha/v1' } })).toBe(1);
  });

  it('migrates unversioned V0 fixture to MedhaSnapshot V1', () => {
    const rawV0 = loadFixture('v0-unversioned.json');
    const result = migrateStoreSnapshot(rawV0);

    expect(result.migrated).toBe(true);
    expect(result.fromVersion).toBe(0);
    expect(result.toVersion).toBe(CURRENT_SNAPSHOT_FORMAT_VERSION);
    expect(result.doc.format).toBe(SNAPSHOT_FORMAT);
    expect(result.doc.formatVersion).toBe(1);
    expect(result.doc.episodes).toHaveLength(2);
    expect(result.doc.episodes[0]?.key.id).toBe('rule-v0-1');
    expect(result.doc.episodes[1]?.key.id).toBe('rule-v0-2');
    expect(result.doc.exportedAt).toBe(1727000000000);
  });

  it('migrates legacy Sage V1 fixture to MedhaSnapshot V1', () => {
    const rawSage = loadFixture('v1-sage.json');
    const result = migrateStoreSnapshot(rawSage);

    expect(result.fromVersion).toBe(1);
    expect(result.toVersion).toBe(CURRENT_SNAPSHOT_FORMAT_VERSION);
    expect(result.doc.format).toBe(SNAPSHOT_FORMAT);
    expect(result.doc.formatVersion).toBe(1);
    expect(result.doc.episodes).toHaveLength(1);
    expect(result.doc.episodes[0]?.key.id).toBe('rule-sage-1');
    expect(result.doc.registries.kinds).toContain('prompt');
    expect(result.doc.meta['sweep:lastRun']).toBe('1727100000000');
  });

  it('accepts and passes through current Medha V1 fixture without mutation', () => {
    const rawCurrent = loadFixture('v1-current.json');
    const result = migrateStoreSnapshot(rawCurrent);

    expect(result.migrated).toBe(false);
    expect(result.fromVersion).toBe(1);
    expect(result.toVersion).toBe(1);
    expect(result.doc.format).toBe(SNAPSHOT_FORMAT);
    expect(result.doc.formatVersion).toBe(1);
    expect(result.doc.episodes[0]?.key.id).toBe('rule-medha-1');
  });

  it('rejects future snapshot versions with typed SchemaVersionError', () => {
    const rawFuture = loadFixture('v99-future.json');
    expect(() => migrateStoreSnapshot(rawFuture)).toThrow(SchemaVersionError);
  });

  it('emits explicit formatVersion: 1 on engine.backup()', async () => {
    const store = new SQLiteStore({ path: ':memory:' });
    const medha = new Medha({ store });
    await medha.open({ now: Date.now() });

    const { snapshot } = await medha.backup();
    expect(snapshot.format).toBe('sutras.medha/v1');
    expect(snapshot.formatVersion).toBe(1);
    expect(typeof snapshot.exportedAt).toBe('number');
  });

  it('restores migrated V0 fixture into engine and round-trips to V1 backup', async () => {
    const store = new SQLiteStore({ path: ':memory:' });
    const medha = new Medha({ store });
    await medha.open({ now: Date.now() });

    const rawV0 = loadFixture('v0-unversioned.json');
    const { restored, migration } = await medha.restore(rawV0);

    expect(restored.from).toBe(0);
    expect(migration).toEqual({ from: 0, to: 1 });

    // Verify entities are loaded and queryable
    const entities = await medha.list({}, { now: Date.now() });
    expect(entities.items.map((e) => e.key.id).sort()).toEqual(['rule-v0-1', 'rule-v0-2']);

    // Verify taking a new backup writes formatVersion 1
    const { snapshot: newBackup } = await medha.backup();
    expect(newBackup.formatVersion).toBe(1);
    expect(newBackup.format).toBe('sutras.medha/v1');
    expect(newBackup.episodes).toHaveLength(2);
  });

  it('restores legacy Sage V1 fixture into engine with preserved registries', async () => {
    const store = new SQLiteStore({ path: ':memory:' });
    const medha = new Medha({ store });
    await medha.open({ now: Date.now() });

    const rawSage = loadFixture('v1-sage.json');
    const { restored } = await medha.restore(rawSage);
    expect(restored.from).toBe(0);

    const entities = await medha.list({}, { now: Date.now() });
    expect(entities.items[0]?.key.id).toBe('rule-sage-1');
  });
});
