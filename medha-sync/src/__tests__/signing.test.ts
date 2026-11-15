/**
 * Signed episodes across sync (medha-nwf.4): merge identity per signer, signed-beats-unsigned, and
 * verify-on-pull screening for each signing mode.
 */

import { describe, expect, it } from 'bun:test';
import {
  APPLY,
  createSigner,
  type Episode,
  type EpisodeInput,
  episodeId,
  generateSigningKey,
  type Keyring,
  type Signer,
  signEpisode,
} from '@cntxt-labs/medha-core';
import { mergeEpisodes, screenIncoming } from '../index.ts';

const KEY = { namespace: '', kind: 'rule', id: 'r1' };

function signer(): Signer {
  return createSigner(generateSigningKey().privateKeyPem);
}

function signal(at: number, author: string): EpisodeInput {
  return { type: 'signal', key: KEY, at, spec: APPLY, ensure: true, author };
}

function seq(inputs: readonly EpisodeInput[]): Episode[] {
  return inputs.map((input, i) => ({ ...input, seq: i }) as Episode);
}

describe('merge identity with signatures', () => {
  it('keeps identical content signed by two principals as two episodes', () => {
    const a = signer();
    const b = signer();
    const merged = mergeEpisodes(
      seq([signEpisode(signal(1000, 'agent:a'), a)]),
      seq([signEpisode(signal(1000, 'agent:b'), b)]),
    );
    expect(merged).toHaveLength(2);
  });

  it('a signed copy beats an unsigned copy of the same content, in either order', () => {
    const a = signer();
    const unsigned = seq([signal(1000, 'agent:a')]);
    const signed = seq([signEpisode(signal(1000, 'agent:a'), a)]);
    for (const [l, r] of [
      [unsigned, signed],
      [signed, unsigned],
    ] as const) {
      const merged = mergeEpisodes(l, r);
      expect(merged).toHaveLength(1);
      expect(merged[0]?.sig?.keyId).toBe(a.keyId);
    }
  });

  it('is still idempotent and commutative for signed logs', () => {
    const a = signer();
    const left = seq([signEpisode(signal(1, 'agent:a'), a), signal(2, 'x')]);
    const right = seq([signEpisode(signal(3, 'agent:a'), a)]);
    expect(mergeEpisodes(left, right)).toEqual(mergeEpisodes(right, left));
    const once = mergeEpisodes(left, right);
    expect(mergeEpisodes(once, once)).toEqual(once);
  });
});

describe('screenIncoming (verify on pull)', () => {
  const a = signer();
  const keyring: Keyring = {
    version: 1,
    keys: [{ keyId: a.keyId, publicKey: a.publicKey, principal: 'agent:a', roles: ['agent'] }],
  };
  const good = signEpisode(signal(1, 'agent:a'), a);
  const forged = signEpisode(signal(2, 'agent:a'), signer()); // unknown key
  const incoming = seq([
    good,
    signal(3, 'agent:a'),
    forged,
    signEpisode(
      {
        type: 'retract',
        key: KEY,
        at: 4,
        targetSeq: 2,
        targetId: episodeId(forged),
        reason: 'x',
        author: 'agent:a',
      },
      a,
    ),
  ]);

  it('off accepts everything silently', () => {
    expect(screenIncoming(incoming, { mode: 'off', keyring })).toEqual({
      accepted: incoming,
      rejected: [],
      flagged: [],
    });
  });

  it('warn accepts everything and flags what require would refuse', () => {
    const screened = screenIncoming(incoming, { mode: 'warn', keyring });
    expect(screened.accepted).toHaveLength(4);
    expect(screened.flagged.map((f) => f.seq)).toEqual([1, 2, 3]);
  });

  it('require refuses unsigned, invalid, and retracts of refused episodes', () => {
    const screened = screenIncoming(incoming, { mode: 'require', keyring });
    expect(screened.accepted.map((e) => e.seq)).toEqual([0]);
    expect(screened.rejected).toEqual([
      { seq: 1, reason: 'unsigned' },
      { seq: 2, reason: 'unknown key' },
      { seq: 3, reason: 'retracts a refused episode' },
    ]);
  });
});

describe('sync package signatures and git trustBefore', () => {
  it('signs and verifies snapshot.sig.json with FileSyncAdapter', async () => {
    const { createTestStore } = await import('./test-store.ts');
    const { FileSyncAdapter } = await import('../file.ts');
    const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const tempDir = mkdtempSync(join(tmpdir(), 'medha-sync-sig-'));
    try {
      const snapFile = join(tempDir, 'snapshot.json');
      const sigFile = join(tempDir, 'snapshot.sig.json');

      const a = signer();
      const keyring: Keyring = {
        version: 1,
        keys: [{ keyId: a.keyId, publicKey: a.publicKey, principal: 'agent:a', roles: ['agent'] }],
      };

      const store1 = createTestStore();
      await store1.open();
      await store1.append(signEpisode(signal(100, 'agent:a'), a));

      // Push with signer
      const adapter1 = new FileSyncAdapter({
        store: store1,
        filePath: snapFile,
        signing: { mode: 'require', keyring },
        signer: a,
      });
      const pushRes = await adapter1.push();
      expect(pushRes.ok).toBe(true);
      expect(existsSync(sigFile)).toBe(true);

      // Pull with requirePackageSignature
      const store2 = createTestStore();
      await store2.open();
      const adapter2 = new FileSyncAdapter({
        store: store2,
        filePath: snapFile,
        signing: { mode: 'require', keyring, requirePackageSignature: true },
      });
      const pullRes = await adapter2.pull();
      expect(pullRes.ok).toBe(true);
      expect(pullRes.pulledCount).toBe(1);

      // Pull with requirePackageSignature but unknown key in keyring
      const unknownKeyring: Keyring = { version: 1, keys: [] };
      const adapter3 = new FileSyncAdapter({
        store: store2,
        filePath: snapFile,
        signing: { mode: 'require', keyring: unknownKeyring, requirePackageSignature: true },
      });
      const pullBad = await adapter3.pull();
      expect(pullBad.ok).toBe(false);
      expect(pullBad.error).toContain('Invalid package signature');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('derives trustBefore from git revocation commit timestamp (medha-nwf.9)', async () => {
    const { deriveGitTrustBefore } = await import('../git.ts');
    const keyring: Keyring = {
      version: 1,
      keys: [
        {
          keyId: 'ed25519:test',
          publicKey: 'pk',
          principal: 'agent:x',
          roles: ['agent'],
          revoked: {
            at: 2000,
            reason: 'compromised',
            trustBefore: null,
          },
        },
      ],
    };

    const derived = deriveGitTrustBefore(keyring, 1500);
    expect(derived.keys[0]?.revoked?.trustBefore).toBe(1500);
  });
});
