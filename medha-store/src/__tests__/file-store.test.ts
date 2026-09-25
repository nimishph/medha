import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REJECT_CONTEXT, REJECT_RULE, type StorePort } from '@cntxt-labs/medha-core';
import { runStoreContractSuite, type StoreContractSetup } from '../contract-suite.ts';
import { FilePolicyStore } from '../file-store.ts';

const HOST_SIGNAL = {
  name: 'ADOPTED',
  value: 0.6,
  countsAsTrial: true,
  countsAsSuccess: true,
} as const;

const EXTRA_KIND = 'locator';

const now = 1_700_000_000_000;

const registries = {
  kinds: [EXTRA_KIND],
  signalSpecs: [HOST_SIGNAL],
  anchorKinds: ['week'],
};

const TMP = mkdtempSync(join(tmpdir(), 'medha-file-'));
let counter = 0;
const freshDir = () => join(TMP, `store-${counter++}`);
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const storeAt = (dir: string): StorePort => new FilePolicyStore({ dir, registries });

const setup: StoreContractSetup = {
  extraKind: EXTRA_KIND,
  hostSignal: HOST_SIGNAL,
  async create() {
    return storeAt(freshDir());
  },
  async createCorrupt() {
    const dir = freshDir();
    const store = storeAt(dir);
    await store.open();
    await store.append({
      type: 'signal',
      key: { namespace: 'n', kind: 'rule', id: 'r1' },
      at: now,
      spec: REJECT_CONTEXT,
      ensure: true,
    });
    await store.append({
      type: 'signal',
      key: { namespace: 'n', kind: 'rule', id: 'r1' },
      at: now + 1,
      spec: REJECT_RULE,
      ensure: true,
    });
    await store.close();
    // Hand-edit the document: a log that wobbles past seq 1 with an unknown kind.
    const doc = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as {
      layoutVersion: number;
      registries: unknown;
      episodes: unknown[];
    };
    doc.episodes.push({
      type: 'signal',
      seq: 2,
      key: { namespace: 'n', kind: 'mystery', id: 'r1' },
      at: now + 2,
      spec: REJECT_CONTEXT,
      ensure: true,
    });
    writeFileSync(join(dir, 'state.json'), JSON.stringify(doc, null, 2));
    return storeAt(dir);
  },
};

runStoreContractSuite(setup);

describe('file store — atomic writes, backup fallback, layout (spec §7.1)', () => {
  test('each append commits atomically: main rolls forward, backup holds the previous doc, no temp lingers', async () => {
    const dir = freshDir();
    const store = storeAt(dir);
    await store.open();
    await store.append({
      type: 'signal',
      key: { namespace: 'n', kind: 'rule', id: 'r1' },
      at: now,
      spec: REJECT_CONTEXT,
      ensure: true,
    });
    await store.append({
      type: 'signal',
      key: { namespace: 'n', kind: 'rule', id: 'r1' },
      at: now + 1,
      spec: REJECT_RULE,
      ensure: true,
    });
    await store.close();

    // After two commits there is the governed document and the previous one as `state.json.bak`.
    const main = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as {
      episodes: unknown[];
    };
    const backup = JSON.parse(readFileSync(join(dir, 'state.json.bak'), 'utf8')) as {
      episodes: unknown[];
    };
    expect(main.episodes).toHaveLength(2);
    expect(backup.episodes).toHaveLength(1);
    expect(existsSync(join(dir, 'state.json.tmp'))).toBe(false);
  });

  test('a stale .tmp from a crashed commit is ignored, not loaded', async () => {
    const dir = freshDir();
    const store = storeAt(dir);
    await store.open();
    await store.append({
      type: 'signal',
      key: { namespace: 'n', kind: 'rule', id: 'r1' },
      at: now,
      spec: REJECT_CONTEXT,
      ensure: true,
    });
    await store.close();
    const good = readFileSync(join(dir, 'state.json'), 'utf8');
    // Simulate a crash between write-temp and rename: a torn temp, untouched main.
    writeFileSync(join(dir, 'state.json.tmp'), '{ "layoutVersion": 1, "episodes": null');
    const reopened = storeAt(dir);
    const result = await reopened.open();
    expect(result.status).toBe('ok');
    expect((await reopened.episodes()).map((e) => e.seq)).toEqual([0]);
    expect(readFileSync(join(dir, 'state.json'), 'utf8')).toBe(good);
  });

  test('backup fallback: an unreadable main document serves the last good snapshot and refuses writes', async () => {
    const dir = freshDir();
    const store = storeAt(dir);
    await store.open();
    await store.append({
      type: 'signal',
      key: { namespace: 'n', kind: 'rule', id: 'r1' },
      at: now,
      spec: REJECT_CONTEXT,
      ensure: true,
    });
    // A second commit rolls the first document into `state.json.bak`, so a torn main has a fallback.
    await store.append({
      type: 'signal',
      key: { namespace: 'n', kind: 'rule', id: 'r1' },
      at: now + 1,
      spec: REJECT_RULE,
      ensure: true,
    });
    await store.close();
    writeFileSync(join(dir, 'state.json'), 'not json {');
    const reopened = storeAt(dir);
    const result = await reopened.open();
    expect(result.status).toBe('corrupt');
    if (result.status === 'corrupt') expect(result.location.source).toContain('state.json');
    // The backup snapshot (one REJECT_CONTEXT) is served; the corrupt second commit is not.
    expect(await reopened.get({ namespace: 'n', kind: 'rule', id: 'r1' })).toBeDefined();
    expect((await reopened.episodes()).map((e) => e.seq)).toEqual([0]);
    await expect(
      reopened.append({
        type: 'signal',
        key: { namespace: 'n', kind: 'rule', id: 'r2' },
        at: now,
        spec: REJECT_CONTEXT,
        ensure: true,
      }),
    ).rejects.toThrow();
  });

  test('layout 0 documents migrate to the current layout on the next commit', async () => {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        episodes: [
          {
            type: 'signal',
            seq: 0,
            key: { namespace: 'n', kind: 'rule', id: 'r1' },
            at: now,
            spec: REJECT_CONTEXT,
            ensure: true,
          },
        ],
      }),
    );
    const store = storeAt(dir);
    const result = await store.open();
    expect(result.status).toBe('ok');
    expect((await store.episodes()).map((e) => e.seq)).toEqual([0]);
    await store.append({
      type: 'signal',
      key: { namespace: 'n', kind: 'rule', id: 'r2' },
      at: now + 1,
      spec: REJECT_CONTEXT,
      ensure: true,
    });
    await store.close();
    const doc = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as {
      layoutVersion: number;
      registries: { kinds: string[] };
    };
    expect(doc.layoutVersion).toBe(1);
    expect(doc.registries.kinds).toContain('rule');
  });

  test('a document from a newer layout version is refused with the typed error', async () => {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({ layoutVersion: 99, registries, episodes: [] }),
    );
    await expect(storeAt(dir).open()).rejects.toThrow();
  });
});
