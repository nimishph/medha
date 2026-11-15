import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
  verify,
} from 'node:crypto';
import type { Episode, EpisodeInput } from './episode.ts';
import { InvalidArgumentError } from './errors.ts';

/**
 * Signed episodes, keyring and verification (medha-nwf.4; design: docs/design/signing-key-model.md).
 *
 * An episode may carry `sig = {keyId, value}`: an Ed25519 signature over its canonical payload
 * (RFC 8785 JSON of the episode without `seq`, `sig` and a retract's local `targetSeq`, prefixed
 * with a domain tag). A keyring — public material only, committed and reviewed — binds each key to
 * a principal, roles and an optional namespace scope. Verification is a pure function of
 * (episode, keyring), so two replicas with the same keyring agree on which episodes count.
 */

export type KeyRole = 'agent' | 'human' | 'maintainer';
export const KEY_ROLES: readonly KeyRole[] = ['agent', 'human', 'maintainer'];

export interface KeyRevocation {
  readonly at: number;
  readonly reason: string;
  /** Episodes with `at < trustBefore` stay valid; `null`/absent revokes every episode (D7). */
  readonly trustBefore?: number | null | undefined;
}

export interface KeyRecord {
  readonly keyId: string;
  /** Raw 32-byte Ed25519 public key, base64url without padding. */
  readonly publicKey: string;
  /** The author string this key signs as; `author` must equal it or start with `principal/`. */
  readonly principal: string;
  readonly roles: readonly KeyRole[];
  /** Namespaces this key may sign in; absent = all. */
  readonly namespaces?: readonly string[] | undefined;
  readonly validFrom?: number | null | undefined;
  /** Set by rotation: episodes with `at >= validUntil` no longer verify. */
  readonly validUntil?: number | null | undefined;
  readonly revoked?: KeyRevocation | null | undefined;
  readonly supersedes?: string | null | undefined;
  readonly comment?: string | undefined;
}

export interface Keyring {
  readonly version: 1;
  readonly keys: readonly KeyRecord[];
}

export const EMPTY_KEYRING: Keyring = { version: 1, keys: [] };

export type SigningMode = 'off' | 'warn' | 'require';
export const SIGNING_MODES: readonly SigningMode[] = ['off', 'warn', 'require'];

export interface SigningPolicy {
  readonly mode: SigningMode;
  readonly keyring: Keyring;
  readonly requirePackageSignature?: boolean | undefined;
}

export const EPISODE_DOMAIN = 'medha-episode-v1\n';
export const SNAPSHOT_DOMAIN = 'medha-snapshot-v1\n';

// ---------------------------------------------------------------------------------------------
// canonical JSON (RFC 8785)
// ---------------------------------------------------------------------------------------------

/**
 * RFC 8785 (JCS) serialization: object members sorted by UTF-16 code units, no whitespace,
 * ECMAScript number formatting, `undefined` members omitted. Non-finite numbers and `undefined`
 * array elements are refused rather than silently coerced to `null`.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new InvalidArgumentError('canonicalJson', 'finite numbers only', value);
      }
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value
          .map((item) => {
            if (item === undefined) {
              throw new InvalidArgumentError('canonicalJson', 'no undefined array elements', item);
            }
            return canonicalJson(item);
          })
          .join(',')}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((k) => record[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
    }
    default:
      throw new InvalidArgumentError('canonicalJson', 'JSON-representable data', typeof value);
  }
}

// ---------------------------------------------------------------------------------------------
// payload, ids
// ---------------------------------------------------------------------------------------------

/** The episode as signed: without `seq`, `sig`, and a retract's local `targetSeq`. */
export function signableEpisode(episode: Episode | EpisodeInput): Record<string, unknown> {
  const { seq: _seq, sig: _sig, ...rest } = episode as Episode;
  if (rest.type === 'retract') {
    const { targetSeq: _targetSeq, ...withoutTarget } = rest;
    return withoutTarget;
  }
  return rest;
}

/** The exact bytes an episode signature covers. */
export function signingPayload(episode: Episode | EpisodeInput): Buffer {
  return Buffer.from(EPISODE_DOMAIN + canonicalJson(signableEpisode(episode)), 'utf8');
}

/** Stable cross-replica episode id: base64url(SHA-256(payload)). Independent of `seq` and `sig`. */
export function episodeId(episode: Episode | EpisodeInput): string {
  return createHash('sha256').update(signingPayload(episode)).digest('base64url');
}

function rawPublicKey(key: KeyObject): string {
  const jwk = key.export({ format: 'jwk' });
  if (jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new InvalidArgumentError('key', 'an Ed25519 key', jwk.crv);
  }
  return jwk.x;
}

function publicKeyObject(publicKey: string): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' });
}

/** `ed25519:` + base64url of the first 16 bytes of SHA-256(raw public key). */
export function keyIdFor(publicKey: string): string {
  const raw = Buffer.from(publicKey, 'base64url');
  if (raw.length !== 32) {
    throw new InvalidArgumentError('publicKey', 'a 32-byte Ed25519 key (base64url)', publicKey);
  }
  return `ed25519:${createHash('sha256').update(raw).digest().subarray(0, 16).toString('base64url')}`;
}

// ---------------------------------------------------------------------------------------------
// keys and signing
// ---------------------------------------------------------------------------------------------

export interface GeneratedKey {
  readonly keyId: string;
  readonly publicKey: string;
  /** PKCS#8 PEM. Never write this under the (often committed) home directory. */
  readonly privateKeyPem: string;
}

export function generateSigningKey(): GeneratedKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = rawPublicKey(publicKey);
  return {
    keyId: keyIdFor(raw),
    publicKey: raw,
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
}

export interface Signer {
  readonly keyId: string;
  readonly publicKey: string;
  signBytes(payload: Uint8Array): string;
}

/** A signer over a PKCS#8 PEM private key. */
export function createSigner(privateKeyPem: string): Signer {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch (cause) {
    throw new InvalidArgumentError('privateKey', 'a PKCS#8 PEM Ed25519 private key', '<redacted>', {
      cause,
    });
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new InvalidArgumentError(
      'privateKey',
      'an Ed25519 private key',
      privateKey.asymmetricKeyType,
    );
  }
  const publicKey = rawPublicKey(createPublicKey(privateKey));
  return {
    keyId: keyIdFor(publicKey),
    publicKey,
    signBytes: (payload) => sign(null, payload, privateKey).toString('base64url'),
  };
}

/** Attach a signature to an episode input (replacing any previous one). */
export function signEpisode<T extends EpisodeInput>(input: T, signer: Signer): T {
  // The payload excludes `sig`, so re-signing an already-signed input is well defined.
  return { ...input, sig: { keyId: signer.keyId, value: signer.signBytes(signingPayload(input)) } };
}

// ---------------------------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------------------------

export type VerifyOutcome =
  | { readonly status: 'unsigned' }
  | { readonly status: 'verified'; readonly keyId: string; readonly principal: string }
  | { readonly status: 'invalid'; readonly keyId?: string | undefined; readonly reason: string };

/** Does `author` fall under `principal` (equal, or `principal/<sub-label>`)? */
export function authorMatchesPrincipal(author: string | undefined, principal: string): boolean {
  return author === principal || (author?.startsWith(`${principal}/`) ?? false);
}

const MAINTAINER_TYPES = new Set(['baseline', 'override']);
const publicKeyCache = new Map<string, KeyObject>();

function cachedPublicKey(publicKey: string): KeyObject {
  let key = publicKeyCache.get(publicKey);
  if (key === undefined) {
    key = publicKeyObject(publicKey);
    publicKeyCache.set(publicKey, key);
  }
  return key;
}

/**
 * Verify one episode against a keyring (design D4–D7). Pure in (episode, keyring). Only a
 * `verified` episode may count in `require` mode; `unsigned` and `invalid` never do.
 */
export function verifyEpisode(episode: Episode | EpisodeInput, keyring: Keyring): VerifyOutcome {
  const sig = episode.sig;
  if (sig === undefined) return { status: 'unsigned' };
  const invalid = (reason: string): VerifyOutcome => ({
    status: 'invalid',
    keyId: sig.keyId,
    reason,
  });
  const record = keyring.keys.find((k) => k.keyId === sig.keyId);
  if (record === undefined) return invalid('unknown key');

  let ok = false;
  try {
    ok = verify(
      null,
      signingPayload(episode),
      cachedPublicKey(record.publicKey),
      Buffer.from(sig.value, 'base64url'),
    );
  } catch {
    ok = false;
  }
  if (!ok) return invalid('bad signature');

  if (!authorMatchesPrincipal(episode.author, record.principal)) {
    return invalid(`author '${episode.author ?? ''}' is not principal '${record.principal}'`);
  }
  if (episode.author?.startsWith('human:') && !record.roles.includes('human')) {
    return invalid("a 'human:' author needs a key with the human role");
  }
  if (MAINTAINER_TYPES.has(episode.type) && !record.roles.includes('maintainer')) {
    return invalid(`a '${episode.type}' episode needs a key with the maintainer role`);
  }
  if (record.namespaces !== undefined && !record.namespaces.includes(episode.key.namespace)) {
    return invalid(`namespace '${episode.key.namespace}' is outside the key's scope`);
  }
  if (record.validFrom != null && episode.at < record.validFrom) {
    return invalid('episode predates the key');
  }
  if (record.validUntil != null && episode.at >= record.validUntil) {
    return invalid('key was rotated out before this episode');
  }
  if (record.revoked != null) {
    const trustBefore = record.revoked.trustBefore;
    if (trustBefore == null || episode.at >= trustBefore) return invalid('key revoked');
  }
  if (episode.type === 'retract' && episode.targetId === undefined) {
    return invalid('a signed retract must carry targetId');
  }
  return { status: 'verified', keyId: record.keyId, principal: record.principal };
}

/**
 * The fold-time admission filter for a policy: `undefined` (admit everything) unless the mode is
 * `require`, in which case only verified episodes are admitted. Results are memoised per episode
 * object, since the same log is folded repeatedly.
 */
export function admitFilter(
  policy: SigningPolicy | undefined,
): ((e: Episode) => boolean) | undefined {
  if (policy === undefined || policy.mode !== 'require') return undefined;
  const memo = new WeakMap<Episode, boolean>();
  return (episode) => {
    let admitted = memo.get(episode);
    if (admitted === undefined) {
      admitted = verifyEpisode(episode, policy.keyring).status === 'verified';
      memo.set(episode, admitted);
    }
    return admitted;
  };
}

// ---------------------------------------------------------------------------------------------
// package signatures (medha-nwf.8)
// ---------------------------------------------------------------------------------------------

export interface PackageSignature {
  readonly keyId: string;
  readonly value: string;
}

export function snapshotSigningPayload(snapshotJsonBytes: Uint8Array | string): Buffer {
  const bytes =
    typeof snapshotJsonBytes === 'string'
      ? Buffer.from(snapshotJsonBytes, 'utf8')
      : Buffer.from(snapshotJsonBytes);
  return Buffer.concat([Buffer.from(SNAPSHOT_DOMAIN, 'utf8'), bytes]);
}

export function signSnapshot(
  snapshotJsonBytes: Uint8Array | string,
  signer: Signer,
): PackageSignature {
  return {
    keyId: signer.keyId,
    value: signer.signBytes(snapshotSigningPayload(snapshotJsonBytes)),
  };
}

export function verifySnapshot(
  snapshotJsonBytes: Uint8Array | string,
  sig: PackageSignature | unknown,
  keyring: Keyring,
): VerifyOutcome {
  if (typeof sig !== 'object' || sig === null) return { status: 'unsigned' };
  const s = sig as Partial<PackageSignature>;
  if (typeof s.keyId !== 'string' || typeof s.value !== 'string') {
    return { status: 'unsigned' };
  }
  const record = keyring.keys.find((k) => k.keyId === s.keyId);
  if (record === undefined) {
    return { status: 'invalid', keyId: s.keyId, reason: 'unknown key' };
  }
  let ok = false;
  try {
    ok = verify(
      null,
      snapshotSigningPayload(snapshotJsonBytes),
      cachedPublicKey(record.publicKey),
      Buffer.from(s.value, 'base64url'),
    );
  } catch {
    ok = false;
  }
  if (!ok) return { status: 'invalid', keyId: s.keyId, reason: 'bad signature' };
  if (record.revoked != null) {
    return { status: 'invalid', keyId: s.keyId, reason: 'key revoked' };
  }
  return { status: 'verified', keyId: record.keyId, principal: record.principal };
}

// ---------------------------------------------------------------------------------------------
// keyring validation
// ---------------------------------------------------------------------------------------------

function optionalNumber(path: string, value: unknown): void {
  if (value != null && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new InvalidArgumentError(path, 'a finite epoch-ms number or null', value);
  }
}

/** Validate an untrusted keyring document (e.g. `.medha/keys/keyring.json`). */
export function validateKeyring(raw: unknown): Keyring {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidArgumentError('keyring', 'an object {version: 1, keys: [...]}', raw);
  }
  const doc = raw as Record<string, unknown>;
  if (doc.version !== 1) throw new InvalidArgumentError('keyring.version', '1', doc.version);
  if (!Array.isArray(doc.keys))
    throw new InvalidArgumentError('keyring.keys', 'an array', doc.keys);
  const seen = new Set<string>();
  doc.keys.forEach((entry: unknown, i: number) => {
    const at = `keyring.keys[${i}]`;
    if (typeof entry !== 'object' || entry === null) {
      throw new InvalidArgumentError(at, 'a key record', entry);
    }
    const r = entry as Record<string, unknown>;
    if (typeof r.publicKey !== 'string') {
      throw new InvalidArgumentError(`${at}.publicKey`, 'a base64url string', r.publicKey);
    }
    const derived = keyIdFor(r.publicKey);
    if (r.keyId !== derived) {
      throw new InvalidArgumentError(
        `${at}.keyId`,
        `the id derived from publicKey (${derived})`,
        r.keyId,
      );
    }
    if (seen.has(derived)) throw new InvalidArgumentError(`${at}.keyId`, 'unique', derived);
    seen.add(derived);
    if (typeof r.principal !== 'string' || r.principal.trim() === '' || r.principal.includes('/')) {
      throw new InvalidArgumentError(
        `${at}.principal`,
        "a non-empty string without '/'",
        r.principal,
      );
    }
    if (
      !Array.isArray(r.roles) ||
      r.roles.length === 0 ||
      !r.roles.every((role) => KEY_ROLES.includes(role as KeyRole))
    ) {
      throw new InvalidArgumentError(
        `${at}.roles`,
        `a non-empty subset of ${KEY_ROLES.join('|')}`,
        r.roles,
      );
    }
    if (
      r.namespaces !== undefined &&
      (!Array.isArray(r.namespaces) || !r.namespaces.every((ns) => typeof ns === 'string'))
    ) {
      throw new InvalidArgumentError(`${at}.namespaces`, 'an array of strings', r.namespaces);
    }
    optionalNumber(`${at}.validFrom`, r.validFrom);
    optionalNumber(`${at}.validUntil`, r.validUntil);
    if (r.revoked != null) {
      const rev = r.revoked as Record<string, unknown>;
      optionalNumber(`${at}.revoked.at`, rev.at);
      if (typeof rev.at !== 'number') {
        throw new InvalidArgumentError(`${at}.revoked.at`, 'an epoch-ms number', rev.at);
      }
      if (typeof rev.reason !== 'string' || rev.reason.trim() === '') {
        throw new InvalidArgumentError(`${at}.revoked.reason`, 'a non-empty string', rev.reason);
      }
      optionalNumber(`${at}.revoked.trustBefore`, rev.trustBefore);
    }
    if (r.supersedes != null && typeof r.supersedes !== 'string') {
      throw new InvalidArgumentError(`${at}.supersedes`, 'a keyId string or null', r.supersedes);
    }
  });
  return raw as Keyring;
}
