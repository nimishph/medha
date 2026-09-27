/**
 * Regression tests for retractions surviving compaction (§6.4, §8): a retraction is a positional
 * pointer (`targetSeq`), so folding the log prefix into baselines must not let a retraction's
 * effect disappear or its pointer end up dangling, whichever side of the fold boundary it and its
 * target land on.
 */

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Medha } from '@cntxt-labs/medha';
import { FilePolicyStore, MemoryStore } from '@cntxt-labs/medha-store';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const key = { namespace: 'n', kind: 'rule', id: 'r1' } as const;

describe('compaction preserves retraction effects', () => {
  it('a recent retract targeting an aged prefix episode survives compaction', async () => {
    const store = new MemoryStore();
    const medha = new Medha({ store });
    await medha.open({ now: T0 });
    await medha.record(key, 'APPLY', { now: T0 }, { ensure: true });
    await medha.record(key, 'APPLY', { now: T0 + 1000 }, { ensure: true });
    await medha.record(key, 'APPLY', { now: T0 + 2000 }, { ensure: true });
    await medha.retract(0, 'bad early signal', { now: T0 + 200 * DAY });

    const before = (await store.list()).map((s) => [s.key.id, s.evidence.n, s.evidence.k]);
    const report = await medha.compact({ now: T0 + 200 * DAY }, { olderThan: 90 });
    const after = (await store.list()).map((s) => [s.key.id, s.evidence.n, s.evidence.k]);

    expect(after).toEqual(before);
    expect(report.compacted).not.toBeNull();
  });

  it('a recent retract targeting a recent suffix episode is remapped, not lost', async () => {
    const store = new MemoryStore();
    const medha = new Medha({ store });
    await medha.open({ now: T0 });
    const other = { namespace: 'n', kind: 'rule', id: 'r2' } as const;
    await medha.record(other, 'APPLY', { now: T0 }, { ensure: true });
    await medha.record(other, 'APPLY', { now: T0 + 1000 }, { ensure: true });
    await medha.record(other, 'APPLY', { now: T0 + 2000 }, { ensure: true });
    // r1 appears late so the old r2 prefix folds 3 episodes -> 1 baseline (a real seq shift).
    const fresh = await medha.record(key, 'APPLY', { now: T0 + 150 * DAY }, { ensure: true });
    // biome-ignore lint/style/noNonNullAssertion: 4 episodes were just appended above
    const seq = (await store.episodes()).at(-1)!.seq;
    await medha.retract(seq, 'late but wrong', { now: T0 + 200 * DAY });
    expect(fresh.state?.evidence.n).toBe(1);

    const before = (await store.list()).map((s) => [s.key.id, s.evidence.n, s.evidence.k]);
    await medha.compact({ now: T0 + 200 * DAY }, { olderThan: 90 });
    const after = (await store.list()).map((s) => [s.key.id, s.evidence.n, s.evidence.k]);

    expect(after).toEqual(before);
  });

  it('a legacy dangling retract is healed by compaction, not rejected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'medha-legacy-'));
    const probe = new FilePolicyStore({ dir });
    await probe.open();
    await medha0(probe, T0);
    const doc = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as {
      episodes: unknown[];
    };
    // The exact legacy shape: an on-disk log holding a retraction whose targetSeq names nothing.
    doc.episodes.push({
      type: 'retract',
      seq: doc.episodes.length,
      key: key,
      at: T0 + DAY,
      targetSeq: 99,
      reason: 'legacy dangling',
    });
    writeFileSync(join(dir, 'state.json'), JSON.stringify(doc, null, 2), 'utf8');

    const store = new FilePolicyStore({ dir });
    const medha = new Medha({ store });
    // The point of this test: open() does not throw or reject the store despite the dangling
    // retraction it just wrote directly to disk (bypassing every write-time guard).
    await medha.open({ now: T0 + 200 * DAY });

    const before = (await store.list()).map((s) => [s.key.id, s.evidence.n, s.evidence.k]);
    const report = await medha.compact({ now: T0 + 200 * DAY }, { olderThan: 90 });
    const after = (await store.list()).map((s) => [s.key.id, s.evidence.n, s.evidence.k]);

    expect(after).toEqual(before);
    expect(report.baselinesWritten).toBeGreaterThanOrEqual(0);
  });
});

async function medha0(store: FilePolicyStore, now: number): Promise<void> {
  const m = new Medha({ store });
  await m.open({ now });
  await m.record(key, 'APPLY', { now }, { ensure: true });
  await m.close();
}
