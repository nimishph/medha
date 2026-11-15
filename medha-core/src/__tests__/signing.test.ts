import { describe, expect, test } from 'bun:test';
import type { EntityKey } from '../entity.ts';
import {
  type Episode,
  type EpisodeInput,
  foldLog,
  signalLimitKey,
  validateEpisodeInput,
} from '../episode.ts';
import { InvalidArgumentError } from '../errors.ts';
import { KindRegistry } from '../kinds.ts';
import { APPLY, SignalRegistry } from '../signals.ts';
import {
  admitFilter,
  canonicalJson,
  createSigner,
  episodeId,
  generateSigningKey,
  type KeyRecord,
  type Keyring,
  keyIdFor,
  type Signer,
  signEpisode,
  signingPayload,
  validateKeyring,
  verifyEpisode,
} from '../signing.ts';

/** RFC 8032 §7.1 test 1: a fixed Ed25519 key, so signatures (deterministic) can be pinned. */
const RFC8032_SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const RFC8032_PUBLIC = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';

function pemFromSeed(seedHex: string): string {
  const der = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(seedHex, 'hex'),
  ]);
  return `-----BEGIN PRIVATE KEY-----\n${der.toString('base64')}\n-----END PRIVATE KEY-----\n`;
}

const KEY: EntityKey = { namespace: 'team-a', kind: 'rule', id: 'r1' };

function record(signer: Signer, overrides: Partial<KeyRecord> = {}): KeyRecord {
  return {
    keyId: signer.keyId,
    publicKey: signer.publicKey,
    principal: 'agent:ci',
    roles: ['agent'],
    ...overrides,
  };
}

function signal(at: number, author?: string): EpisodeInput {
  return {
    type: 'signal',
    key: KEY,
    at,
    spec: APPLY,
    ensure: true,
    ...(author === undefined ? {} : { author }),
  };
}

function withSeq(input: EpisodeInput, seq: number): Episode {
  return { ...input, seq } as Episode;
}

describe('canonicalJson (RFC 8785)', () => {
  test('sorts keys, drops undefined members, no whitespace', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], c: undefined, d: { z: 0.5, y: -0 } })).toBe(
      '{"a":[true,null,"x"],"b":1,"d":{"y":0,"z":0.5}}',
    );
  });
  test('refuses non-finite numbers and undefined array elements', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(InvalidArgumentError);
    expect(() => canonicalJson([undefined])).toThrow(InvalidArgumentError);
  });
});

describe('payload and ids', () => {
  test('the RFC 8032 key derives its documented public key', () => {
    const signer = createSigner(pemFromSeed(RFC8032_SEED));
    expect(Buffer.from(signer.publicKey, 'base64url').toString('hex')).toBe(RFC8032_PUBLIC);
    expect(signer.keyId).toBe(keyIdFor(signer.publicKey));
    expect(signer.keyId.startsWith('ed25519:')).toBe(true);
  });

  test('seq, sig and a retract targetSeq are outside the payload', () => {
    const base = signal(1000, 'agent:ci');
    expect(episodeId(withSeq(base, 0))).toBe(episodeId(withSeq(base, 42)));
    const signer = createSigner(pemFromSeed(RFC8032_SEED));
    expect(episodeId(signEpisode(base, signer))).toBe(episodeId(base));
    const retract = (targetSeq: number): EpisodeInput => ({
      type: 'retract',
      key: KEY,
      at: 5,
      targetSeq,
      targetId: episodeId(base),
      reason: 'noise',
    });
    expect(signingPayload(retract(1)).equals(signingPayload(retract(9)))).toBe(true);
  });

  test('signatures are deterministic for a fixed key', () => {
    const signer = createSigner(pemFromSeed(RFC8032_SEED));
    const a = signEpisode(signal(1000, 'agent:ci'), signer);
    const b = signEpisode(signal(1000, 'agent:ci'), signer);
    expect(a.sig).toEqual(b.sig);
  });
});

describe('verifyEpisode', () => {
  const signer = createSigner(pemFromSeed(RFC8032_SEED));
  const ring = (overrides: Partial<KeyRecord> = {}): Keyring => ({
    version: 1,
    keys: [record(signer, overrides)],
  });

  test('unsigned, verified, unknown key', () => {
    expect(verifyEpisode(signal(1, 'agent:ci'), ring()).status).toBe('unsigned');
    const signed = signEpisode(signal(1, 'agent:ci'), signer);
    expect(verifyEpisode(signed, ring())).toEqual({
      status: 'verified',
      keyId: signer.keyId,
      principal: 'agent:ci',
    });
    expect(verifyEpisode(signed, { version: 1, keys: [] })).toMatchObject({
      status: 'invalid',
      reason: 'unknown key',
    });
  });

  test('tampering with any signed field breaks the signature', () => {
    const signed = signEpisode(signal(1, 'agent:ci'), signer);
    const tampered = { ...signed, at: 2 };
    expect(verifyEpisode(tampered, ring())).toMatchObject({ reason: 'bad signature' });
  });

  test('author is bound to the principal; sub-labels are allowed', () => {
    expect(verifyEpisode(signEpisode(signal(1, 'agent:ci/run-7'), signer), ring()).status).toBe(
      'verified',
    );
    expect(verifyEpisode(signEpisode(signal(1, 'agent:other'), signer), ring()).status).toBe(
      'invalid',
    );
    expect(verifyEpisode(signEpisode(signal(1, 'agent:cix'), signer), ring()).status).toBe(
      'invalid',
    );
  });

  test("'human:' needs the human role; baselines and overrides need maintainer", () => {
    const human = signEpisode(signal(1, 'human:ada'), signer);
    expect(verifyEpisode(human, ring({ principal: 'human:ada' })).status).toBe('invalid');
    expect(verifyEpisode(human, ring({ principal: 'human:ada', roles: ['human'] })).status).toBe(
      'verified',
    );
    const override = signEpisode(
      { type: 'override', key: KEY, at: 1, override: 'retired', reason: 'x', author: 'agent:ci' },
      signer,
    );
    expect(verifyEpisode(override, ring()).status).toBe('invalid');
    expect(verifyEpisode(override, ring({ roles: ['agent', 'maintainer'] })).status).toBe(
      'verified',
    );
  });

  test('namespace scope', () => {
    const signed = signEpisode(signal(1, 'agent:ci'), signer);
    expect(verifyEpisode(signed, ring({ namespaces: ['team-a'] })).status).toBe('verified');
    expect(verifyEpisode(signed, ring({ namespaces: ['team-b'] })).status).toBe('invalid');
  });

  test('rotation keeps episodes before validUntil', () => {
    const early = signEpisode(signal(999, 'agent:ci'), signer);
    const late = signEpisode(signal(1000, 'agent:ci'), signer);
    expect(verifyEpisode(early, ring({ validUntil: 1000 })).status).toBe('verified');
    expect(verifyEpisode(late, ring({ validUntil: 1000 })).status).toBe('invalid');
  });

  test('revocation is total unless trustBefore keeps older episodes', () => {
    const early = signEpisode(signal(10, 'agent:ci'), signer);
    const late = signEpisode(signal(20, 'agent:ci'), signer);
    const revoked = { at: 30, reason: 'lost' };
    expect(verifyEpisode(early, ring({ revoked })).status).toBe('invalid');
    const kept = ring({ revoked: { ...revoked, trustBefore: 15 } });
    expect(verifyEpisode(early, kept).status).toBe('verified');
    expect(verifyEpisode(late, kept).status).toBe('invalid');
  });

  test('a signed retract must carry targetId', () => {
    const retract = signEpisode(
      { type: 'retract', key: KEY, at: 5, targetSeq: 0, reason: 'x', author: 'agent:ci' },
      signer,
    );
    expect(verifyEpisode(retract, ring())).toMatchObject({
      reason: 'a signed retract must carry targetId',
    });
  });
});

describe('fold under require mode', () => {
  const signer = createSigner(pemFromSeed(RFC8032_SEED));
  const keyring: Keyring = { version: 1, keys: [record(signer)] };

  test('admitFilter is a no-op outside require mode', () => {
    expect(admitFilter(undefined)).toBeUndefined();
    expect(admitFilter({ mode: 'warn', keyring })).toBeUndefined();
  });

  test('only verified episodes count; an unverified retract masks nothing', () => {
    const admit = admitFilter({ mode: 'require', keyring });
    const log: Episode[] = [
      withSeq(signEpisode(signal(1, 'agent:ci'), signer), 0),
      withSeq(signal(2, 'agent:forged'), 1),
      withSeq({ type: 'retract', key: KEY, at: 3, targetSeq: 0, reason: 'unsigned attack' }, 2),
    ];
    const [state] = foldLog(log, { admit });
    expect(state?.evidence).toMatchObject({ k: 1, n: 1 });
    expect(foldLog(log)[0]?.evidence).toMatchObject({ k: 1, n: 1 }); // unfiltered: retract masks #0, unsigned #1 counts
  });

  test('signal limits key signed episodes by principal, so sub-labels cannot bypass them', () => {
    const kinds = new KindRegistry([{ name: 'rule', signalLimits: { maxSuccessesPerAuthor: 2 } }]);
    const log = [1, 2, 3, 4].map((i) =>
      withSeq(signEpisode(signal(i * 1000, `agent:ci/run-${i}`), signer), i - 1),
    );
    const [state] = foldLog(log, { kinds });
    expect(state?.evidence.k).toBe(2);
    expect(state?.authors?.['agent:ci']).toMatchObject({ counted: 2, suppressed: 2 });
    expect(signalLimitKey(signal(1, 'agent:ci/x'))).toBe('agent:ci/x'); // unsigned: unchanged
  });
});

describe('validation', () => {
  test('validateKeyring checks derived ids and roles', () => {
    const k = generateSigningKey();
    const good = {
      version: 1,
      keys: [{ keyId: k.keyId, publicKey: k.publicKey, principal: 'agent:x', roles: ['agent'] }],
    };
    expect(validateKeyring(good)).toBe(good as unknown as Keyring);
    expect(() =>
      validateKeyring({ version: 1, keys: [{ ...good.keys[0], keyId: 'ed25519:forged' }] }),
    ).toThrow(InvalidArgumentError);
    expect(() =>
      validateKeyring({ version: 1, keys: [{ ...good.keys[0], roles: ['root'] }] }),
    ).toThrow(InvalidArgumentError);
    expect(() =>
      validateKeyring({ version: 1, keys: [{ ...good.keys[0], principal: 'a/b' }] }),
    ).toThrow(InvalidArgumentError);
  });

  test('episodes with a malformed sig are refused at the store boundary', () => {
    const validation = { kinds: new KindRegistry(), signals: new SignalRegistry() };
    const bad = { ...signal(1), sig: { keyId: 'ed25519:x', value: 'short' } };
    expect(() => validateEpisodeInput(bad, validation)).toThrow(InvalidArgumentError);
    const signer = createSigner(pemFromSeed(RFC8032_SEED));
    expect(() => validateEpisodeInput(signEpisode(signal(1), signer), validation)).not.toThrow();
  });
});
