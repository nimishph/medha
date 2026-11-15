# Decision: key model for signed episodes (keys, rotation, revocation)

**Task:** medha-nwf.3 · **Epic:** medha-nwf (Safe: signing, dedupe, isolation) · **Unblocks:** medha-nwf.4
**Status:** Accepted. The TypeScript implementation shipped in medha-nwf.4 (see §7); the Rust port and the package signature are follow-ups.
**Date:** 2026-10-01

## 1. Problem

`author` on an episode (`medha-core/src/episode.ts`, `BaseEpisode.author`) is a caller-supplied
string. The CLI fills it from `--author`, `MEDHA_AUTHOR`, `USER` or `USERNAME`
(`cli/src/write.ts` `resolveAuthor`), and MCP callers pass whatever they like. Everything that
depends on who wrote an episode trusts that string:

- **Signal limits** (spec §9.1) key their ledger by `author`. An agent that varies the string
  sidesteps `maxSuccessesPerAuthor`/`minIntervalMs`. The spec already names this gap.
- **Decision policy** (`isHumanAuthor`, medha-arj.4) treats `human:<id>` as a verified human.
  Any caller can type `human:`.
- **`allowedAuthors`** (`medha/src/engine.ts`) is an allow-list of strings, not of identities.
- **Sync** (`medha-sync/src/merge.ts`) accepts every episode in a pulled snapshot. It also ships
  derived `entities`, which a peer can fabricate directly.

medha-nwf.4 will sign episodes and verify them on pull. It needs these settled first: what a key
is, how an author is bound to a key, what exactly gets signed, and how keys rotate and get
revoked, all without breaking the fold's determinism or replica convergence.

## 2. Constraints from the existing design

1. **The log is the source of truth and the fold is pure.** Verification must be a pure function
   of *(log, keyring)*, so two replicas with the same keyring agree on which episodes count.
2. **`seq` is local.** Merge, compaction and resequencing renumber it, so a signature cannot cover
   `seq`. A `retract`'s `targetSeq` is renumbered as well (medha-8gx).
3. **Merge identity ignores `author`.** `contentKey` does not include it. Two episodes that
   differ only by author dedupe to one entry today.
4. **Two implementations.** The TypeScript packages and the Rust crates (`crates/medha-*`) must
   produce byte-identical signing payloads. Anything signed needs conformance vectors.
5. **No new runtime dependencies** unless unavoidable. Bun ≥ 1.3 ships `node:crypto`.
6. **Backward compatible by default.** Existing unsigned logs keep working unless an operator
   opts in.

## 3. Decisions

### D1. Algorithm: Ed25519

Use Ed25519 (RFC 8032, pure mode, no prehash).

- It's built into `node:crypto` (`generateKeyPairSync('ed25519')`, `sign(null, …)`), so the TS
  side needs no dependency. On the Rust side, `ed25519-dalek` is the standard crate.
- Signatures are deterministic, so conformance vectors can pin exact signature bytes from a
  fixed test key.
- Keys (32 B) and signatures (64 B) are small, which matters because every episode carries one.

Rejected: ECDSA P-256 (non-deterministic signatures break vector pinning), RSA (large), and
reusing SSH/GPG keys directly (see D3's note on SSH import).

### D2. Key identity

- `publicKey`: raw 32-byte Ed25519 key, base64url without padding.
- `keyId`: `ed25519:` followed by the first 16 bytes of `SHA-256(raw public key)`, as base64url.
  The id is derived, never chosen, so it can't be spoofed with a different key.

### D3. Principal and roles: the keyring

A **key record** binds a key to a principal:

```jsonc
{
  "keyId": "ed25519:…",
  "publicKey": "…",
  "principal": "agent:ci-reviewer",     // the author string this key may sign as
  "roles": ["agent"],                   // "agent" | "human" | "maintainer"
  "namespaces": ["team-a"],             // optional; absent = all namespaces
  "validFrom": 1790000000000,           // epoch ms
  "validUntil": null,                   // set by rotation (D6)
  "revoked": null,                      // set by revocation (D7)
  "supersedes": null,                   // keyId this one rotated from
  "comment": "CI reviewer on runner pool 2"
}
```

The **keyring** is the list of key records the home trusts:

- It lives at `.medha/keys/keyring.json`, which holds **public material only** and is meant to be
  committed and changed through normal code review. Whoever can merge to the repo controls trust.
  That matches how `config.json` registries are already shared.
- **Private keys never live under `.medha/`**, because the home is often committed. They go in
  `~/.config/medha/keys/<keyId>.key` (on Windows, `%APPDATA%\medha\keys\`), file mode 0600, PKCS#8
  PEM. For agents and CI, `MEDHA_SIGNING_KEY` holds the PEM or a path to it.
- Which private key a process signs with comes from `--signing-key <keyId>` or
  `MEDHA_SIGNING_KEY`, or else `signing.defaultKey` in config.
- A snapshot received through sync **never** adds to the keyring. A peer can't vouch for itself.
  Snapshots may carry key records as a convenience (`meta`/`keys`), but they are shown as
  "unendorsed" until someone adds them to the committed keyring.
- `medha keys import-ssh <file>` may convert an existing `ssh-ed25519` public key into a record.
  This is only a convenience: the record, not the SSH key, is what's trusted.

### D4. Binding author to key

A signed episode verifies only if all of these hold:

1. `keyId` is in the keyring, and the signature verifies over the payload (D5).
2. `author === principal`, or `author` starts with `principal + "/"`. The sub-label form allows
   `agent:ci-reviewer/run-42` for the read plane.
3. `author` starts with `human:` only if the key has the `human` role. This turns
   `isHumanAuthor`'s convention into a checked claim.
4. The episode's namespace is in `namespaces` when that list is set.
5. The key is in its validity window and not revoked (D6, D7).

**Limits key by principal, not by author string.** For a verified episode, the signal-limits
ledger (§9.1) and `allowedAuthors` use the key's `principal`. That rules out rotating sub-labels
as a way around the limits. Unsigned episodes keep today's behavior of keying by the raw
`author`, which is exactly what `require` mode (D8) turns off.

### D5. What is signed: the canonical payload

```
payload = "medha-episode-v1\n" || canonicalJSON(episode without seq, sig, and local-only fields)
```

- **canonicalJSON** is RFC 8785 (JCS): sorted keys, no whitespace, ECMAScript number
  serialization, and `undefined` members omitted. Every number that reaches an episode is already
  `round6`ed or an integer, so JCS number formatting is stable across TS and Rust. Vectors must
  cover `value`, `weight`, `theta0` and `probability` edge cases.
- The prefix is for domain separation, so a signature over an episode can never be replayed as a
  signature over a snapshot (D9) or a keyring change.
- **Excluded:** `seq`, `sig`, and (for `retract`) `targetSeq`.
- **`retract` changes shape.** New retractions carry `targetId`, the episode id (below) of the
  episode they mask, and that field is signed. `targetSeq` stays as a local cache that merge keeps
  rewriting. A signed retract with no `targetId` is invalid. This also gives `mergeEpisodes` a
  signed identity to resolve against instead of re-deriving `contentKey`.
- **Episode id:** `base64url(SHA-256(payload))`. It's stable across replicas and renumbering, and
  it's what `targetId`, audit output and D8's grandfathering refer to.

The envelope goes on the episode as an optional field:

```ts
readonly sig?: { readonly keyId: string; readonly value: string /* base64url, 64 B */ };
```

**Merge identity.** For a signed episode, the merge/dedupe identity becomes `contentKey + keyId`.
Otherwise, two principals that sign identical content would dedupe to one of them, and which one
survived would depend on arrival order. If the same content arrives both signed and unsigned, the
signed copy wins, so stripping a signature on the wire can't downgrade an episode. Unsigned
episodes keep the current `contentKey`, so existing logs merge exactly as they do now.

### D6. Rotation (planned, not a compromise)

`medha keys rotate <oldKeyId>`:

1. Generates a new key and adds a record with `supersedes: oldKeyId`, the same principal, and the
   same roles and namespaces.
2. Sets `validUntil = now` on the old record. The old private key file is deleted locally.
3. Episodes the old key signed **stay valid** when `at < validUntil`. History is not re-signed:
   re-signing would change episode ids and break every `targetId` that references them.

Known limitation: `at` is caller-supplied, so someone holding a *retired* key could backdate. That
is exactly why rotation deletes the old private key, and why a key that may have leaked must be
**revoked**, not rotated.

### D7. Revocation (compromise)

`medha keys revoke <keyId> --reason <text> [--trust-before <epoch ms>]` sets:

```jsonc
"revoked": { "at": 1790500000000, "reason": "laptop lost", "trustBefore": null }
```

- By default (`trustBefore: null`), **every** episode the key signed stops verifying, whatever its
  `at`. Backdating makes any cutoff based on `at` meaningless, so the safe default is total.
- `trustBefore` lets a maintainer keep episodes with `at < trustBefore` when they have
  out-of-band evidence of when the compromise started. It is an explicit, reviewed override,
  never automatic.
- **Revocation never deletes episodes.** Episodes that fail verification are excluded from the
  fold's input (D8). Because the fold is pure, state is simply recomputed. If a revocation is
  undone (the record is edited back), the episodes count again and nothing is lost. The
  `removal audit` surface should list episodes that were excluded because a key was revoked.
- The compromised principal gets a new key through a normal new record, not through `supersedes`,
  so nothing inherits trust from the revoked key.

Considered and deferred: using the git-ref sync history as a trusted timestamp. An episode that
was already in a `refs/medha/memory` commit before the revocation commit is provably not
backdated. That would let `trustBefore` be derived automatically for git sync. It's a good
follow-up, but it ties verification to one sync adapter, so it's out of scope for v1.

### D8. Policy modes and legacy logs

`config.json` gets:

```jsonc
"signing": {
  "mode": "off",            // "off" | "warn" | "require"
  "defaultKey": null,       // keyId used to sign local writes
  "requirePackageSignature": false
}
```

| mode | local writes | pulled / merged episodes | fold input |
|---|---|---|---|
| `off` (default) | signed if a key is configured | all accepted | all episodes |
| `warn` | signed if a key is configured | all accepted; invalid or unsigned ones reported | all episodes |
| `require` | **must** be signed; the write fails without a key | invalid/unsigned rejected at pull, before merge | verified episodes only |

- In `require` mode, verification runs as a filter in front of the fold, and again at the sync
  boundary. Filtering at pull keeps garbage out of the log. Filtering at fold makes revocation
  (D7) take effect without rewriting the log.
- **Legacy unsigned episodes:** `medha keys adopt` runs the existing compaction (§8) and signs the
  resulting `baseline` episodes with a maintainer-role key. The signed baseline is the
  maintainer's endorsement of all the history it summarizes. After that, `require` can be turned
  on without losing state. No timestamp-based cutoff is offered, for the same backdating reason
  as in D7.
- `baseline`, `sweep` and `proposal` episodes that Medha generates itself (compaction, maintain,
  digest) are signed by the key of whoever runs the operation, usually a maintainer. Only
  maintainer-role keys may sign `baseline` and `override` episodes in `require` mode.

### D9. Sync packages

- Per-episode signatures are the authority. A pushed snapshot mixes episodes from many
  principals, so one package signature can't vouch for their content.
- Under `require`, the receiver **ignores the snapshot's `entities`** (derived state a peer could
  fabricate) and refolds from the verified episodes. Snapshots with no `episodes` are rejected in
  `require` mode.
- A **package signature** is optional and supplementary. It's a detached `snapshot.sig.json`
  containing `{keyId, value}` over `"medha-snapshot-v1\n" || bytes of snapshot.json`. It
  authenticates *who pushed* and detects transport tampering, which is useful for audit and for
  `requirePackageSignature: true` on untrusted remotes. It never makes an unsigned episode inside
  the snapshot acceptable.

## 4. Consequences

- The §9.1 gap ("author is a caller-supplied label until episodes are signed") is closed in
  `require` mode. The spec paragraph should be updated when medha-nwf.4 lands.
- `isHumanAuthor` becomes meaningful under `require`. It stays a naming convention otherwise, and
  the docs must say so.
- Episode size grows by about 110 bytes (`keyId` plus a 64 B signature, base64url).
  Verification costs about 50 µs per episode. Pulls should cache verified episode ids, keyed by
  a keyring hash, so revalidation only happens when the keyring changes.
- The `retract` shape gains `targetId`, which is a spec change (a new minor spec version).
  `define`/`decision` fold-purity (§11a) is unaffected: signing is metadata and happens before
  the fold.
- Merge identity for signed episodes includes `keyId`. `merge.ts` and the Rust `merge.rs` must
  change together, with a vector for "same content, two signers".

## 5. Work for medha-nwf.4 (checklist)

1. `medha-core`: `sig` field, `canonicalPayload`, `episodeId`, `verifyEpisode(ep, keyring)`,
   keyring types and validation, `retract.targetId`.
2. `medha-core` fold entry points: an optional verified-filter plus principal-keyed signal limits.
3. `medha-sync`: verify on pull by mode, `keyId`-aware merge identity, refolding instead of trusting
   `entities`, optional `snapshot.sig.json`.
4. CLI: `medha keys generate | list | rotate | revoke | adopt | import-ssh`, the `--signing-key`
   flag, and a `signing` section in config and `schemas/config.v1.json`.
5. MCP: the server signs with the home's key; the agent-supplied `author` must fall under that
   key's principal (D4) or the write is refused.
6. Rust crates: the same payload, id and verify functions, via `ed25519-dalek`.
7. Conformance vectors (`docs/spec/vectors/signing.json`): a fixed RFC 8032 test key, canonical
   payload bytes, id, signature, and verify outcomes for wrong principal, missing `human` role,
   namespace outside scope, rotated-valid, rotated-after-`validUntil`, revoked,
   revoked-with-`trustBefore`, and signed-beats-unsigned merge.

## 6. Owner decisions (2026-10-01)

- **Keyring change control:** v1 trusts whoever can commit `keyring.json`. A maintainer-signed
  keyring (TUF-style root metadata) is deferred until there is a multi-org deployment.
- **Default mode for new homes:** `off`, so `medha init` stays zero-config. `medha init --secure`
  (generate a key and set `require`) is an optional later convenience.

## 7. Implementation notes (medha-nwf.4)

Normative text: trust spec §13 (spec 1.6.0). Vectors: `docs/spec/vectors/signing.json`.

- **Core** (`medha-core/src/signing.ts`): `canonicalJson`, `signingPayload`, `episodeId`,
  `keyIdFor`, `generateSigningKey`, `createSigner`, `signEpisode`, `verifyEpisode`, `admitFilter`,
  `validateKeyring`. `Episode.sig`, `RetractEpisode.targetId`, `FoldEpisodeOptions.admit` and
  `signalLimitKey` live in `episode.ts`.
- **Stores** accept `admit` and expose it on `StorePort`. A non-admitted episode stays in the log but
  does not fold. That is how revocation excludes episodes without deleting them.
- **Engine** (`Medha({ signing: { policy, signer } })`): every append goes through one `sign()`
  step. It fills an absent author with the principal, refuses an author outside it, and enforces
  `require`. Compaction folds with the store's `admit` and stops before any non-admitted episode.
  Its baselines are signed, and under `require` it declines (session sweep) or refuses (explicit
  `compact`) without a maintainer key. `adopt()` implements `medha keys adopt`.
- **Sync**: `screenIncoming` runs before `mergeEpisodes` in both adapters. `PullResult` reports
  `rejected` (require) and `flagged` (warn). The adapters already refolded from episodes and never
  trusted a snapshot's `entities`, so D9's first rule needed no change.
- **CLI**: `medha keys generate | list | rotate | revoke | verify | mode | adopt`. The config gains
  `signing: {mode, defaultKey}`, and the schema is updated. When the home signs, `resolveAuthor`
  drops the `$USER` fallback. MCP writes inherit the engine's checks.

Deviations from the text above:
- `validFrom` is optional and unset by `generate`/`rotate`. Setting it would make backdated
  `--at` writes fail after a rotation, for no security gain (`at` is caller-supplied either way).
- `adopt` folds every *unsigned or verified* episode and stops at the first *invalid* one. It never
  endorses evidence the keyring has disowned.
- `requirePackageSignature` and `snapshot.sig.json` (D9, package signature) are not implemented.
  Per-episode signatures carry the authority, and the package signature is supplementary. Tracked
  as a follow-up.
- The Rust crates are not yet ported: payload/id/verify, principal-keyed limits and admission.
  `signing.json` exists so the port can be checked byte-for-byte.
