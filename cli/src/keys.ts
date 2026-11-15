import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  admitFilter,
  createSigner,
  EMPTY_KEYRING,
  type Episode,
  generateSigningKey,
  InvalidArgumentError,
  KEY_ROLES,
  type KeyRecord,
  type KeyRole,
  type Keyring,
  type Signer,
  type SigningMode,
  type SigningPolicy,
  validateKeyring,
  verifyEpisode,
} from '@cntxt-labs/medha-core';
import type { Environment } from './environment.ts';
import { ConfigFileError } from './errors.ts';
import { homeFor, type MedhaConfigV1, readConfig, storeForConfig, writeConfig } from './layout.ts';

/**
 * Episode signing on the CLI side (medha-nwf.4; design docs/design/signing-key-model.md).
 *
 * - The keyring (public keys only) lives in the home at `keys/keyring.json` and is meant to be
 *   committed and reviewed: whoever can change it controls trust (owner decision, 2026-10-01).
 * - Private keys never live in the home, which is often committed. They go in the user's key
 *   directory (`MEDHA_KEY_DIR`, else `%APPDATA%\medha\keys` on Windows, else
 *   `$XDG_CONFIG_HOME/medha/keys` / `~/.config/medha/keys`), or arrive through `MEDHA_SIGNING_KEY`
 *   (a PEM, or a path to one) for agents and CI.
 */

export const KEYRING_REL = join('keys', 'keyring.json');

type Env = Readonly<Record<string, string | undefined>>;

export function keyringPathFor(home: string): string {
  return join(home, KEYRING_REL);
}

export function readKeyring(home: string): Keyring {
  const path = keyringPathFor(home);
  if (!existsSync(path)) return EMPTY_KEYRING;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (failure) {
    throw new ConfigFileError(path, 'not valid JSON', { cause: failure });
  }
  try {
    return validateKeyring(parsed);
  } catch (failure) {
    throw new ConfigFileError(path, failure instanceof Error ? failure.message : String(failure), {
      cause: failure,
    });
  }
}

export function writeKeyring(home: string, keyring: Keyring): string {
  validateKeyring(keyring);
  const path = keyringPathFor(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(keyring, null, 2)}\n`, 'utf8');
  return path;
}

export function keyDirFor(env: Env): string {
  if (env.MEDHA_KEY_DIR) return env.MEDHA_KEY_DIR;
  if (process.platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'medha', 'keys');
  const config = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
  return join(config, 'medha', 'keys');
}

/** `ed25519:abc` → `ed25519_abc.key` (colons are not portable in file names). */
export function privateKeyPathFor(env: Env, keyId: string): string {
  return join(keyDirFor(env), `${keyId.replace(':', '_')}.key`);
}

export function signingPolicyFor(home: string, config: MedhaConfigV1): SigningPolicy {
  return {
    mode: config.signing?.mode ?? 'off',
    keyring: readKeyring(home),
    requirePackageSignature: config.signing?.requirePackageSignature ?? false,
  };
}

/**
 * The signer for this process: `MEDHA_SIGNING_KEY` (PEM text or a path) wins, then an explicit
 * key id, then `signing.defaultKey`. `undefined` when none is configured.
 */
export function loadSigner(config: MedhaConfigV1, env: Env, keyId?: string): Signer | undefined {
  const fromEnv = env.MEDHA_SIGNING_KEY;
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    const pem = fromEnv.includes('-----BEGIN') ? fromEnv : readFileSync(fromEnv, 'utf8');
    return createSigner(pem);
  }
  const id = keyId ?? config.signing?.defaultKey;
  if (id === undefined) return undefined;
  const path = privateKeyPathFor(env, id);
  if (!existsSync(path)) {
    throw new InvalidArgumentError('signing key', `a private key file at ${path}`, id, {
      hint: 'Generate one with `medha keys generate`, or set MEDHA_SIGNING_KEY.',
    });
  }
  const signer = createSigner(readFileSync(path, 'utf8'));
  if (signer.keyId !== id) {
    throw new InvalidArgumentError('signing key', `the private key for ${id}`, signer.keyId);
  }
  return signer;
}

/** The store's fold-time admission filter for a home's policy (verified-only under `require`). */
export function admitFor(policy: SigningPolicy): ((episode: Episode) => boolean) | undefined {
  return admitFilter(policy);
}

// ---------------------------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------------------------

export interface KeysCommonOptions {
  readonly dir?: string | undefined;
  readonly home?: string | undefined;
}

function openConfig(
  options: KeysCommonOptions,
  environment: Environment,
): {
  home: string;
  config: MedhaConfigV1;
} {
  const home = homeFor(options.dir ?? environment.cwd, options.home);
  const config = readConfig(home);
  if (config === null) {
    throw new InvalidArgumentError('home', 'an initialized medha home (run `medha init`)', home);
  }
  return { home, config };
}

function parseRoles(raw: string | undefined): KeyRole[] {
  const roles = (raw ?? 'agent')
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r !== '');
  for (const role of roles) {
    if (!KEY_ROLES.includes(role as KeyRole)) {
      throw new InvalidArgumentError('--role', `one or more of ${KEY_ROLES.join(', ')}`, role);
    }
  }
  if (roles.length === 0) throw new InvalidArgumentError('--role', 'at least one role', raw);
  return roles as KeyRole[];
}

function parseList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  return items.length === 0 ? undefined : items;
}

function writePrivateKey(env: Env, keyId: string, pem: string): string {
  const path = privateKeyPathFor(env, keyId);
  mkdirSync(dirname(path), { recursive: true });
  // `mode` applies on creation (every key file is new); Windows ignores it, and the key directory
  // is per-user there. `wx` refuses to overwrite an existing key.
  writeFileSync(path, pem, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return path;
}

export interface KeysGenerateOptions extends KeysCommonOptions {
  readonly principal: string;
  readonly role?: string | undefined;
  readonly namespace?: string | undefined;
  readonly comment?: string | undefined;
  /** Make this the home's `signing.defaultKey`. */
  readonly setDefault?: boolean | undefined;
}

export interface KeysGenerateReport {
  readonly keyId: string;
  readonly principal: string;
  readonly roles: readonly KeyRole[];
  readonly keyringPath: string;
  readonly privateKeyPath: string;
  readonly isDefault: boolean;
}

export function runKeysGenerate(
  options: KeysGenerateOptions,
  environment: Environment,
): KeysGenerateReport {
  const { home, config } = openConfig(options, environment);
  const principal = options.principal?.trim() ?? '';
  if (principal === '' || principal.includes('/')) {
    throw new InvalidArgumentError('--principal', "a non-empty author id without '/'", principal);
  }
  const roles = parseRoles(options.role);
  const namespaces = parseList(options.namespace);
  const generated = generateSigningKey();
  const record: KeyRecord = {
    keyId: generated.keyId,
    publicKey: generated.publicKey,
    principal,
    roles,
    ...(namespaces === undefined ? {} : { namespaces }),
    validFrom: null,
    validUntil: null,
    revoked: null,
    supersedes: null,
    ...(options.comment === undefined ? {} : { comment: options.comment }),
  };
  const keyring = readKeyring(home);
  const privateKeyPath = writePrivateKey(environment.env, generated.keyId, generated.privateKeyPem);
  const keyringPath = writeKeyring(home, { version: 1, keys: [...keyring.keys, record] });
  const isDefault = options.setDefault === true || config.signing?.defaultKey === undefined;
  if (isDefault) {
    writeConfig(home, {
      ...config,
      signing: { mode: config.signing?.mode ?? 'off', defaultKey: generated.keyId },
    });
  }
  return { keyId: generated.keyId, principal, roles, keyringPath, privateKeyPath, isDefault };
}

export interface KeyListEntry {
  readonly keyId: string;
  readonly principal: string;
  readonly roles: readonly KeyRole[];
  readonly namespaces?: readonly string[] | undefined;
  readonly state: 'active' | 'rotated' | 'revoked';
  readonly hasPrivateKey: boolean;
  readonly isDefault: boolean;
}

export interface KeysListReport {
  readonly mode: SigningMode;
  readonly keyringPath: string;
  readonly keys: readonly KeyListEntry[];
}

export function runKeysList(options: KeysCommonOptions, environment: Environment): KeysListReport {
  const { home, config } = openConfig(options, environment);
  const keyring = readKeyring(home);
  return {
    mode: config.signing?.mode ?? 'off',
    keyringPath: keyringPathFor(home),
    keys: keyring.keys.map((k) => ({
      keyId: k.keyId,
      principal: k.principal,
      roles: k.roles,
      ...(k.namespaces === undefined ? {} : { namespaces: k.namespaces }),
      state: k.revoked != null ? 'revoked' : k.validUntil != null ? 'rotated' : 'active',
      hasPrivateKey: existsSync(privateKeyPathFor(environment.env, k.keyId)),
      isDefault: config.signing?.defaultKey === k.keyId,
    })),
  };
}

function requireRecord(keyring: Keyring, keyId: string): KeyRecord {
  const record = keyring.keys.find((k) => k.keyId === keyId);
  if (record === undefined) {
    throw new InvalidArgumentError(
      'keyId',
      `a key in the keyring (${keyring.keys.map((k) => k.keyId).join(', ') || 'none'})`,
      keyId,
    );
  }
  return record;
}

export interface KeysRotateReport {
  readonly retired: string;
  readonly keyId: string;
  readonly validUntil: number;
  readonly privateKeyPath: string;
  readonly deletedOldPrivateKey: boolean;
}

/**
 * Planned rotation (design D6): a new key for the same principal/roles/namespaces, the old one
 * retired at `now` (its earlier episodes keep verifying) and its private key deleted locally.
 */
export function runKeysRotate(
  options: KeysCommonOptions & { readonly keyId: string },
  environment: Environment,
): KeysRotateReport {
  const { home, config } = openConfig(options, environment);
  const keyring = readKeyring(home);
  const old = requireRecord(keyring, options.keyId);
  if (old.revoked != null) {
    throw new InvalidArgumentError('keyId', 'a key that is not revoked', options.keyId);
  }
  if (old.validUntil != null) {
    throw new InvalidArgumentError('keyId', 'a key that is not already rotated', options.keyId);
  }
  const now = environment.now();
  const generated = generateSigningKey();
  const next: KeyRecord = {
    ...old,
    keyId: generated.keyId,
    publicKey: generated.publicKey,
    validFrom: null,
    validUntil: null,
    revoked: null,
    supersedes: old.keyId,
  };
  const privateKeyPath = writePrivateKey(environment.env, generated.keyId, generated.privateKeyPem);
  writeKeyring(home, {
    version: 1,
    keys: [...keyring.keys.map((k) => (k === old ? { ...k, validUntil: now } : k)), next],
  });
  const oldPath = privateKeyPathFor(environment.env, old.keyId);
  const deletedOldPrivateKey = existsSync(oldPath);
  if (deletedOldPrivateKey) rmSync(oldPath);
  if (config.signing?.defaultKey === old.keyId) {
    writeConfig(home, {
      ...config,
      signing: { mode: config.signing.mode, defaultKey: generated.keyId },
    });
  }
  return {
    retired: old.keyId,
    keyId: generated.keyId,
    validUntil: now,
    privateKeyPath,
    deletedOldPrivateKey,
  };
}

export interface KeysRevokeReport {
  readonly keyId: string;
  readonly at: number;
  readonly reason: string;
  readonly trustBefore: number | null;
}

/**
 * Compromise revocation (design D7): every episode the key signed stops counting unless
 * `trustBefore` keeps the older ones. Nothing is deleted — the store simply stops admitting them.
 */
export function runKeysRevoke(
  options: KeysCommonOptions & {
    readonly keyId: string;
    readonly reason: string;
    readonly trustBefore?: number | undefined;
  },
  environment: Environment,
): KeysRevokeReport {
  const { home } = openConfig(options, environment);
  if (typeof options.reason !== 'string' || options.reason.trim() === '') {
    throw new InvalidArgumentError('--reason', 'a non-empty string', options.reason);
  }
  if (options.trustBefore !== undefined && !Number.isFinite(options.trustBefore)) {
    throw new InvalidArgumentError('--trust-before', 'an epoch-ms number', options.trustBefore);
  }
  const keyring = readKeyring(home);
  const record = requireRecord(keyring, options.keyId);
  const at = environment.now();
  const revoked = { at, reason: options.reason, trustBefore: options.trustBefore ?? null };
  writeKeyring(home, {
    version: 1,
    keys: keyring.keys.map((k) => (k === record ? { ...k, revoked } : k)),
  });
  return { keyId: options.keyId, at, reason: options.reason, trustBefore: revoked.trustBefore };
}

export interface KeysVerifyReport {
  readonly mode: SigningMode;
  readonly total: number;
  readonly verified: number;
  readonly unsigned: number;
  readonly invalid: readonly { readonly seq: number; readonly reason: string }[];
}

/** Verify every episode in the home's log against its keyring — what `require` mode would count. */
export async function runKeysVerify(
  options: KeysCommonOptions,
  environment: Environment,
): Promise<KeysVerifyReport> {
  const { home, config } = openConfig(options, environment);
  const keyring = readKeyring(home);
  const store = storeForConfig(config);
  await store.open();
  try {
    const log = await store.episodes();
    let verified = 0;
    let unsigned = 0;
    const invalid: { seq: number; reason: string }[] = [];
    for (const episode of log) {
      const outcome = verifyEpisode(episode, keyring);
      if (outcome.status === 'verified') verified += 1;
      else if (outcome.status === 'unsigned') unsigned += 1;
      else invalid.push({ seq: episode.seq, reason: outcome.reason });
    }
    return { mode: config.signing?.mode ?? 'off', total: log.length, verified, unsigned, invalid };
  } finally {
    await store.close();
  }
}

export function runKeysMode(
  options: KeysCommonOptions & { readonly mode: string },
  environment: Environment,
): { readonly mode: SigningMode; readonly previous: SigningMode } {
  const { home, config } = openConfig(options, environment);
  const allowed: readonly SigningMode[] = ['off', 'warn', 'require'];
  if (!allowed.includes(options.mode as SigningMode)) {
    throw new InvalidArgumentError('mode', allowed.join(' | '), options.mode);
  }
  const previous = config.signing?.mode ?? 'off';
  writeConfig(home, {
    ...config,
    signing: {
      mode: options.mode as SigningMode,
      ...(config.signing?.defaultKey === undefined
        ? {}
        : { defaultKey: config.signing.defaultKey }),
    },
  });
  return { mode: options.mode as SigningMode, previous };
}

export function renderKeysList(report: KeysListReport): string {
  const lines = [`signing mode: ${report.mode}`, `keyring: ${report.keyringPath}`];
  if (report.keys.length === 0) lines.push('no keys (run `medha keys generate --principal <id>`)');
  for (const k of report.keys) {
    const flags = [
      k.state,
      k.hasPrivateKey ? 'private key here' : null,
      k.isDefault ? 'default' : null,
    ]
      .filter((f) => f !== null)
      .join(', ');
    const scope = k.namespaces === undefined ? '' : ` ns=${k.namespaces.join(',')}`;
    lines.push(`${k.keyId}  ${k.principal}  [${k.roles.join(',')}]${scope}  (${flags})`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderKeysVerify(report: KeysVerifyReport): string {
  const lines = [
    `signing mode: ${report.mode}`,
    `episodes: ${report.total}  verified: ${report.verified}  unsigned: ${report.unsigned}  invalid: ${report.invalid.length}`,
  ];
  for (const bad of report.invalid) lines.push(`  seq ${bad.seq}: ${bad.reason}`);
  if (report.mode === 'require' && report.unsigned + report.invalid.length > 0) {
    lines.push('Under require mode only verified episodes count toward state.');
  }
  return `${lines.join('\n')}\n`;
}
