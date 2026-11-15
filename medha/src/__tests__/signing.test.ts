import { describe, expect, test } from 'bun:test';
import {
  admitFilter,
  createSigner,
  DAY_MS,
  type EntityKey,
  type Episode,
  generateSigningKey,
  type KeyRecord,
  type KeyRole,
  type Keyring,
  PermissionDeniedError,
  type Signer,
  type SigningMode,
  verifyEpisode,
} from '@cntxt-labs/medha-core';
import { MemoryStore } from '@cntxt-labs/medha-store';
import { Medha } from '../engine.ts';

/** Engine-side signing (medha-nwf.4): sign on write, `require` enforcement, compaction, adopt. */

const NOW = 1_700_000_000_000;
const KEY: EntityKey = { namespace: 'ns', kind: 'rule', id: 'r1' };

function newSigner(): Signer {
  return createSigner(generateSigningKey().privateKeyPem);
}

function entry(signer: Signer, principal: string, roles: KeyRole[]): KeyRecord {
  return { keyId: signer.keyId, publicKey: signer.publicKey, principal, roles };
}

function setup(
  mode: SigningMode,
  roles: KeyRole[] = ['agent'],
  initialEpisodes: readonly Episode[] = [],
) {
  const signer = newSigner();
  const keyring: Keyring = { version: 1, keys: [entry(signer, 'agent:ci', roles)] };
  const policy = { mode, keyring };
  const store = new MemoryStore({ initialEpisodes, admit: admitFilter(policy) });
  const medha = new Medha({ store, signing: { policy, signer } });
  return { store, medha, signer, keyring, policy };
}

describe('signing on write', () => {
  test('every appended episode is signed, and the author defaults to the principal', async () => {
    const { store, medha, keyring } = setup('off');
    await medha.record(KEY, 'APPLY', { now: NOW }, { ensure: true });
    await medha.record(KEY, 'APPLY', { now: NOW + 1 }, { author: 'agent:ci/run-2' });
    const log = await store.episodes();
    expect(log.map((e) => e.author)).toEqual(['agent:ci', 'agent:ci/run-2']);
    expect(log.every((e) => verifyEpisode(e, keyring).status === 'verified')).toBe(true);
  });

  test('an author outside the principal is refused, not signed', async () => {
    const { medha } = setup('off');
    await expect(
      medha.record(KEY, 'APPLY', { now: NOW }, { ensure: true, author: 'human:ada' }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  test('require mode refuses writes without a usable key', async () => {
    const signer = newSigner();
    const policy = { mode: 'require' as const, keyring: { version: 1 as const, keys: [] } };
    const store = new MemoryStore({ admit: admitFilter(policy) });
    const unsignedEngine = new Medha({ store, signing: { policy } });
    await expect(
      unsignedEngine.record(KEY, 'APPLY', { now: NOW }, { ensure: true }),
    ).rejects.toThrow(/no signing key/);
    const unregistered = new Medha({ store, signing: { policy, signer } });
    await expect(unregistered.record(KEY, 'APPLY', { now: NOW }, { ensure: true })).rejects.toThrow(
      /unknown key/,
    );
  });

  test('retract carries the target episode id', async () => {
    const { medha, store, keyring } = setup('require');
    await medha.record(KEY, 'APPLY', { now: NOW }, { ensure: true });
    const { episode } = await medha.retract(0, 'mistake', { now: NOW + 1 });
    expect(episode.type === 'retract' && episode.targetId).toBeTruthy();
    expect(verifyEpisode(episode, keyring).status).toBe('verified');
    expect(await store.get(KEY)).toBeUndefined();
  });
});

describe('compaction and adoption under require', () => {
  const legacy: Episode[] = [
    { seq: 0, type: 'signal', key: KEY, at: NOW, spec: APPLY_SPEC(), ensure: true },
    { seq: 1, type: 'signal', key: KEY, at: NOW + 1, spec: APPLY_SPEC(), ensure: false },
  ];

  test('unsigned legacy episodes do not count, and compaction does not fold them', async () => {
    const { medha, store } = setup('require', ['agent', 'maintainer'], legacy);
    await store.open();
    expect(await store.list()).toEqual([]);
    const report = await medha.compact({ now: NOW + 400 * DAY_MS }, { olderThan: 90 });
    expect(report.compacted).toBeNull();
    expect(await store.episodes()).toHaveLength(2);
  });

  test('adopt folds the legacy log into maintainer-signed baselines that count', async () => {
    const { medha, store, keyring } = setup('require', ['agent', 'maintainer'], legacy);
    const report = await medha.adopt({ now: NOW + 10 });
    expect(report.baselinesWritten).toBe(1);
    const log = await store.episodes();
    expect(log.every((e) => verifyEpisode(e, keyring).status === 'verified')).toBe(true);
    expect((await store.get(KEY))?.evidence).toMatchObject({ k: 2, n: 2 });
  });

  test('adopt refuses a key without the maintainer role', async () => {
    const { medha, store } = setup('require', ['agent'], legacy);
    await expect(medha.adopt({ now: NOW + 10 })).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(await store.episodes()).toHaveLength(2);
  });
});

function APPLY_SPEC() {
  return { name: 'APPLY', value: 1, countsAsTrial: true, countsAsSuccess: true };
}
