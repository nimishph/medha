# Medha trust formula — specification

**Spec version: 1.4.0** (`TRUST_SPEC_VERSION`; conformance vectors carry the version they target.)

This document is the normative definition of how Medha turns an entity's history into a trust
score, a lifecycle status, and the threshold gates. A port (Python, Go, …) is conformant when it
reproduces every vector in `docs/spec/vectors/` (see §9). The TypeScript kernel in `medha-core/src`
is the reference implementation; where this document and the code disagree, that is a bug in one of
them and must be resolved before release.

Keywords MUST / SHOULD follow RFC 2119.

## 1. Conventions

- **Time** is integer epoch milliseconds supplied by the caller (`now`). Implementations MUST NOT
  read a wall clock inside the kernel.
- **Numbers** are IEEE-754 binary64. Every value that leaves the kernel is rounded with
  `round6` (§1.1). Inputs are never rounded implicitly.
- `DAY_MS = 86_400_000`, `WEEK_MS = 7 · DAY_MS`.
- Non-finite values (NaN, ±∞) passed to `round6`, `emaStep`, or a Wilson bound are errors.

### 1.1 `round6(x)`

Round to 6 decimal places, half away from zero, applied to the magnitude:

```
f = 10^6
s = |x| · f
r = trunc(s) + (frac(s) >= 0.5 ? 1 : 0)
round6(x) = sign(x) · r / f
```

The comparison is on the binary64 value of `s`. Ports MUST NOT use decimal-aware or banker's
rounding; a scaled `math.Round` (Go) or `floor(s + 0.5)` on the magnitude is acceptable only if it
matches every vector.

## 2. Parameters (defaults)

| Name | Value | Meaning |
|---|---|---|
| `WILSON_Z` | 1.96 | Wilson quantile |
| `MIN_USES_FOR_TRUSTED` | 5 | trials before `trusted` |
| `TRUSTED_THRESHOLD` | 0.6 | trust needed for `trusted` |
| `ACTIVE_THRESHOLD` | 0.25 | trust needed for `active` |
| `UNGUARDED_TRUST_CEILING` | 0.5 | trust cap for unguarded entities |
| `RECENCY_HALF_LIFE_DAYS` | 45 | recency half-life |
| `RECENCY_FLOOR` | 0.3 | minimum recency factor |
| `DURABILITY_GAIN` | 0.15 | log gain per distinct anchor |
| `DURABILITY_MAX` | 1.5 | durability ceiling |
| `DEFAULT_EMA_ALPHA` | 0.1 | EMA smoothing |
| `MIN_SAMPLES_FOR_DRIFT` | 3 | trials before drift can be flagged |
| `DRIFT_THRESHOLD` | 0.4 | \|μ − θ₀\| that flags drift |
| `DEFAULT_THETA0` | 0.5 | baseline prior of a fresh entity |
| `RETIRED_TRUST_THRESHOLD` | 0.1 | undecayed trust below which an entity retires |
| `MIN_USES_FOR_RETIRED` | 3 | trials before retirement by trust |

A **kind spec** may override, per kind: `thresholds.{trusted, minUsesForTrusted, active,
unguardedCeiling, minUsesForRetired, retiredTrustThreshold}`, `recency.{halfLifeDays, floor}`,
`evidenceWeighting` (`'count'` default | `'signal-value'`), and `signalLimits` (§9.1, off by
default). Overrides replace the default for that
kind only; unspecified fields keep the defaults above.

## 3. Entity state (inputs to the formula)

`evidence.{k, n, contextRejects}`, `guard.{kind, lastOk, lastOkAt}`, `anchors[]`,
`ema.{mu, theta0}`, `lastSignalAt` (nullable), `status`, `override` (nullable).

## 4. Components

### 4.1 Wilson lower bound `L(k, n)`

```
n == 0            -> 0
p  = clamp(k / n, 0, 1)
z2 = z²
centre = p + z2 / (2n)
margin = z · sqrt( max(0, p(1-p)/n) + z2 / (4n²) )
L = round6( max(0, (centre - margin) / (1 + z2/n)) )
```

`k > n` (beyond 1e-9 slack) or negative/non-finite counts are errors. The upper bound is the same
with `+ margin`, capped at 1, and `width = round6(max(0, upper − lower))` (width is 1 when n = 0).

### 4.2 Guard factor `G`

| Guard | G |
|---|---|
| `kind` is `""` or `"none"` (**unguarded**) | 0.5 |
| guarded, `lastOk == false` | 0 |
| guarded, `lastOk == true` | 1 |
| guarded, `lastOk == null` (never reported) | 0.8 |

### 4.3 Recency `R`

```
lastSignalAt == null -> floor
ageDays = max(0, (now - lastSignalAt) / DAY_MS)
R = round6( min(1, max(floor, exp(-ln2 · ageDays / halfLifeDays))) )
```

### 4.4 Durability `D`

`h` = number of distinct anchors. Anchors are distinct by the pair `(kind, value)`. A successful
signal with no host anchor records the fallback anchor `("week", str(floor(at / WEEK_MS)))`.

```
h <= 0 -> 1
D = round6( min(DURABILITY_MAX, 1 + DURABILITY_GAIN · ln(1 + h)) )
```

Unguarded entities use `D = 1` regardless of anchors (nothing was ever verified).

## 5. Trust

```
ceiling = unguarded ? (unguardedCeiling ?? 0.5) : 1
raw     = L · G · R · D
T       = round6( clamp(min(ceiling, raw), 0, 1) )
if unguarded and T >= ceiling: T = round6(ceiling − 1e-6)
```

The last line ensures an unguarded entity is always strictly below its ceiling.

With default parameters the ceiling never binds on its own: an unguarded entity has `G = 0.5` and
`D = 1`, so `raw <= 0.5 · L · R` and `L < 1` at any realistic `n`. It matters only for a per-kind
`unguardedCeiling` below that (e.g. 0.3), or `n` so large that `L` rounds to 1. Ports MUST still
implement it exactly.

**Terminal statuses.** If the stored `status` is `quarantined` or `retired`, `T = 0` (components
are still reported, with `durability = 1`). This is checked on the stored status, before §5.

## 6. Status

Evaluated in this order; the first match wins (`statusFrom`):

1. `override == retired` → `retired`; `override == quarantined` → `quarantined`.
2. stored `status == retired` → `retired`.
3. guard failed (`kind` guarded and `lastOk == false`) → `quarantined`.
4. drifting **downward** (§7, `isDriftingDown`) → `quarantined`.
5. `statusForTrust`:
   1. `n >= minUsesForRetired` **and** `L · G < retiredTrustThreshold` → `retired`
      (uses the *undecayed* product: age alone never retires).
   2. `T >= trusted` **and** `n >= minUsesForTrusted` **and** the guard passed (guarded kind with
      `lastOk == true`) → `trusted`. An unguarded entity is never `trusted`, even if it carries
      `lastOk == true` from a report against kind `none` and a per-kind threshold is low enough.
   3. `T >= active` → `active`.
   4. otherwise `probation`.

## 7. Drift

```
emaStep(mu, s, alpha) = round6( clamp((mu ?? 0)(1−alpha) + alpha·s, 0, 1) )
driftDelta = round6(|mu − theta0|)
driftDownDelta = round6(max(0, theta0 − mu))
isDrifting = n >= MIN_SAMPLES_FOR_DRIFT and driftDelta >= DRIFT_THRESHOLD
isDriftingDown = n >= MIN_SAMPLES_FOR_DRIFT and driftDownDelta >= DRIFT_THRESHOLD
```

**Two predicates, two jobs.** `isDrifting` is the *report* — it answers "how far has the learned
weight moved from the author's baseline", sign included. It backs `medha drift`, the `drifting`
gate (§8), and `temporal.isDrifting`. `isDriftingDown` is the *quarantine gate* (§6 step 4) and is
one-sided.

The asymmetry is load-bearing, not cosmetic. `driftThreshold` is 0.4 and the default `theta0` is
0.5, so a symmetric test is reached by an entity that has only ever succeeded: at the default
`alpha = 0.1`, ~16 consecutive `APPLY`s walk `mu` from 0.5 to 0.9 and trip it. Using that to
quarantine makes sustained success a punishment — the most reliable rules in the store are the ones
that get buried, with `T = 0` and no surfacing. `mu` above the baseline means the entity is
out-performing its prior, which is evidence *for* trust. Only `mu` below the baseline is the
hazard §6 step 4 is about.

Ports MUST keep both predicates: quarantining on `isDrifting` is non-conformant, and so is
suppressing the `drifting` *gate* on entities that drift upward.

## 8. Gates (`explain-threshold`, `clearsThreshold`)

There is exactly one evaluation (`evaluateGates`). A gate is met **iff every one of its conditions
is**; `clearsThreshold` and `explain-threshold` both derive from it.

| Gate | Conditions | `threshold` / `value` |
|---|---|---|
| `trusted` | `T >= trusted`; `n >= minUsesForTrusted`; guard passed (guarded and `lastOk == true`) | trusted threshold / T |
| `active` | `T >= active` | active threshold / T |
| `drifting` | `n >= MIN_SAMPLES_FOR_DRIFT`; `driftDelta >= DRIFT_THRESHOLD` | 0.4 / driftDelta |

Note the `trusted` gate and the `trusted` **status** share their conditions but differ in
precedence: the gate says "the thresholds clear", the status additionally applies §6 steps 1–4.

## 9. Signals and folding

Canonical signals: `APPLY(+1, trial, success)`, `SKIP(0, not a trial)`, `REJECT_CONTEXT(−0.2, not a
trial)`, `REJECT_RULE(−1, trial, not success)`. Hosts may register more.

Applying a signal `s` at time `t`:

- **count weighting** (default): `n += countsAsTrial`, `k += countsAsSuccess`.
- **signal-value weighting**: `n = round6(n + (countsAsTrial ? |value| : 0))`,
  `k = round6(k + (countsAsSuccess ? max(0, value) : 0))`.
- `contextRejects += 1` when the signal is `REJECT_CONTEXT`.
- `mu = emaStep(mu, value, alpha)`.
- `lastSignalAt = t`, **except** `SKIP`, which leaves it unchanged (Invariant III: SKIP never
  counts as evidence and never refreshes recency).
- On `countsAsSuccess`, merge the incoming anchors (or the week fallback) into `anchors`.
- Recompute `status` per §6 at time `t`, **on the entity carrying its previous stored status**.
  Because §5 forces `T = 0` for a stored `quarantined`/`retired` status, the step that leaves
  quarantine (e.g. a guard pass after a failure) evaluates with `T = 0` and stores `probation`
  (or `retired`); the next fold, or any read, evaluates normally. Reads (`statusFrom` at `now`)
  are computed from the stored state and are what `hint.status` reports.

### 9.1 Signal limits (opt-in, since 1.1.0)

Purpose: one author must not be able to inflate an entity's trust by repeating success signals.
Active only when the kind declares `signalLimits` (`minIntervalMs`, `maxSuccessesPerAuthor`, either
or both); with none declared nothing below applies and no `authors` state is kept.

Applies to a signal only when `countsAsSuccess` is true. Negative evidence (`REJECT_RULE`,
`REJECT_CONTEXT`) and `SKIP` are **never** limited: throttling failure reports would let a bad rule
hide its failures. The author key is the episode's `author`, or `""` (one shared anonymous bucket)
when absent. Each entity keeps `authors[author] = {lastAt, counted, suppressed}`.

A success at time `t` is **suppressed** when either
- `minIntervalMs` is set, the author has a counted success, and `t − lastAt < minIntervalMs`
  (out-of-order timestamps therefore suppress), or
- `maxSuccessesPerAuthor` is set and `counted >= maxSuccessesPerAuthor`.

A suppressed success changes **only** `authors[author].suppressed += 1`: no `k`/`n`, no EMA step, no
anchors, no `lastSignalAt`, no status recomputation. Otherwise the success is applied per §9 and
the ledger becomes `{lastAt: t, counted: counted + 1, suppressed}`.

Limits are a pure function of the episode log (`author`, `at`), so replays and compaction
baselines (which embed the ledger) decide identically.

**Limits of this mechanism.** `author` is a caller-supplied label until episodes are signed
(medha-nwf.3/.4): an agent that varies its author string sidesteps the limits. The ledger also
grows with the number of distinct authors; pair it with `allowedAuthors` on untrusted stores.

## 10. Invariants a conformant port MUST preserve

- **I** Determinism: same inputs → same outputs, bit-for-bit after `round6`.
- **III** `SKIP` never changes `k`, `n`, or `lastSignalAt`.
- **IV** An unguarded entity's trust is strictly below its ceiling.
- Age or recency alone never retires an entity.
- `trusted` is unreachable unless the entity is guarded, `guard.lastOk == true`, and
  `n >= minUsesForTrusted` — for any per-kind thresholds (property-tested).
- A gate is met iff all its conditions are met.
- With `signalLimits`, suppressed successes never change evidence, EMA, anchors, recency or status.
- **Fold-purity (since 1.2.0, §11a)**: `define` and `decision` episodes never change `EntityState`
  — stripping every one of them from a log produces byte-identical states to the full log.

## 11a. Definitions and decision trees (since 1.2.0)

Two more episode types ride the same log, both **entirely non-evidential**: applying either MUST
leave `EntityState` byte-for-byte unchanged. A conformant port MUST make `foldEpisode`/its
equivalent treat both as pure no-ops (`return prev`), including when there is no prior state (a
`define`/`decision` episode MUST NOT create an entity, even without an explicit `ensure`-style
flag — there is none for these two types).

**Fold-purity invariant.** For any log, the `EntityState` per key produced by folding it is
identical to the `EntityState` produced by folding the same log with every `define` and `decision`
episode removed (and, symmetrically, with all `signal` episodes' `caseId` stripped — a tagged
signal folds into `EntityState` exactly as it would untagged; see below). Trust math is computed
purely from `signal`/`guard`/`override`/`proposal`/`sweep`/`baseline` episodes. Definitions and
decision-tree structure are metadata riding the same log, read by their own, separate folds.

### 11a.1 `EntityDefinition` (`define` episode)

A host-authored, non-evidential definition: `{ title: string, tags?: string[], rationale: string
}`. `title` and `rationale` MUST be non-empty. `foldDefinitions(episodes):
Map<entityKeyString, EntityDefinition>` rebuilds, per key, the definition from the **last**
`define` episode by `seq` order (latest-write-wins) — independent of `foldEpisode`'s trust fold.

### 11a.2 `DecisionCase` / `Decision` (`decision` episode)

A branch of an entity's decision tree: a condition growing incrementally from usage. `Decision` is
one of `{type: 'apply'}`, `{type: 'ignore'}`, or `{type: 'probability', value}` (`value` in
`[0,1]`). A `DecisionCase` is `{id, parentId?, condition, decision, evidence, ema}` — `evidence`
and `ema` are exactly the same shapes an `EntityState` carries (§3), but scoped to the branch alone
(§11a.3).

A `decision` episode carries `{caseId, parentId?, condition, decision}`. `caseId` is minted by
`newDecisionCaseId(key, random?)`: `<entity-id>-dec-<5-char-alnum>`, where `entityKeyString(key)`
(§9's key-string form) is folded (FNV-1a) into every character of the 5-char suffix. This makes two
*different* entities' ids diverge even when their `random` draws coincide (e.g. both hosts reseed
from a similar clock), while `random`'s entropy is what keeps the *same* entity's repeated calls
from colliding. `random` is caller-supplied (defaults to a non-deterministic source); a port
targeting these vectors MUST accept an injected `random` for reproducibility, exactly as
`Context.seed` already lets `explore` (§6.3) replay deterministically.

`foldDecisionTree(episodes, key): DecisionCase[]` builds the parent-linked forest for one entity
key: only `decision` episodes for that key are read, latest-write-wins per `caseId` by `seq` order
(an "edit" is a later `decision` episode reusing an existing `caseId`).

**Position is inherited, not cleared.** A `decision` episode that names no `parentId` leaves the
branch exactly where it already is: the fold resolves `parentId` as `episode.parentId ??
previous.parentId`. Only an explicit `detach: true` promotes a branch to the top level. An edit
that did not ask to move a branch MUST NOT move it — otherwise the ordinary act of revising a
branch's probability silently rips it out of its subtree, and the tree the author built is not the
tree anyone reads afterwards.

`parentId` is **not** validated by the fold against the tree — a `parentId` naming a case absent
from the log (a dangling reference, or one outside a folded slice) is carried on the case as-is; a
renderer MUST treat it as a root rather than dropping the case.

**Write-time structural validation.** Because the fold must tolerate dangling references from
partial logs, *writers* validate the tree's shape before appending. `validateDecisionTreeEdit(tree,
edit, mode)` is the normative check, and a writer MUST reject a `decision` write that violates it.
`mode` is the caller's intent: omitting a `caseId` mints a branch (`'create'`), while supplying one
asks to revise that branch (`'edit'`) — and under `'edit'` the id must already be in the tree. The
errors for an unknown `caseId` or `parentId` SHOULD list the ids that do exist, so that a mistyped
edit is recoverable without a second guess.

| Rule | Error `field` | Why |
| --- | --- | --- |
| An explicitly supplied `caseId` must name a case this entity already has | `decision.caseId` | A `caseId` is the difference between "mint a branch" and "revise this branch". A typo that mints instead leaves the intended branch untouched and grows a stray leaf with the typo as its id. |
| `parentId` must name a case this entity already has | `decision.parentId` | An unknown parent otherwise produces a root-level branch while the caller believes it built a subtree. |
| `parentId` must not be the branch itself | `decision.parentId` | Trivially self-referential. |
| `parentId` must not be a descendant of the branch | `decision.parentId` | Closes a cycle; every renderer walking parent→children would not terminate. |
| `detach` and `parentId` are mutually exclusive | `decision.detach` | Contradictory intent — refuse rather than pick a winner. |
| No sibling may already use the same condition | `decision.condition` | Two branches with the same text split one condition's evidence across two trust scores that each then read low forever. |

Two conditions are "the same" when they match under `normalizeCondition(c) = lower(trim(collapse(
whitespace, c)))` — so `"in Legacy"` and `"In  Legacy"` collide. Duplicates are scoped **per
parent**: the same condition once under each of two different roots is two genuinely different
branches. An edit that re-states its own condition is not a duplicate.

`detach` is optional and defaults to absent, so a `decision` episode written by an older port (or a
port that never emits it) folds unchanged under the inheritance rule above.

### 11a.3 Per-branch evidence (`SignalEpisode.caseId`)

A `signal` episode MAY carry an optional `caseId`, naming an existing `DecisionCase`. When present:

- The signal folds into `EntityState` **exactly as it would without `caseId`** — untouched,
  unconditional. This is what makes "existing signal-episode behavior with no caseId" trivially
  unchanged: the two paths are the same code path.
- **Additionally**, `foldDecisionTree` rolls the same signal's evidence (§9's `k`/`n`/
  `contextRejects` accrual rule, `evidenceWeighting`-aware) and EMA step (§7's `emaStep`) into
  the named case's own `evidence`/`ema`, isolated from every other case and from the entity's own
  aggregate. A `caseId` naming no case present in the folded slice is silently ignored by the tree
  fold (the signal still folds into `EntityState` as usual).

Because the *fold* must stay tolerant of partial logs, it is the *write* path that refuses a
`caseId` naming no branch of the entity (`options.caseId`). A typo'd `caseId` otherwise does the
worst possible thing: it folds into the entity as usual, the call reads as "it landed somewhere",
and the branch the caller meant to teach stays at `k=0 n=0` forever. Writers MUST reject it and
SHOULD name the existing case ids in the error so the typo is recoverable without a second guess.


This is a deliberate **additive**, not exclusive, design: a branch's evidence is a second,
independent view of the same signal, not a redirection away from the entity's aggregate. A branch
can therefore be `trusted` while its parent entity — whose aggregate has also accrued every other
branch's (and every untagged) signal — reads `quarantined`, or vice versa.

**Scoring a branch** (`caseTrust`/`caseStatus`/`scoreDecisionTree`): a `DecisionCase` has no guard
or anchors of its own. It is scored by constructing a synthetic state with guard `{kind: 'branch',
lastOk: true}` (passed, never unguarded) and no anchors, then applying §5/§6 unchanged. A branch's
trust is therefore driven purely by its own Wilson evidence and EMA — it can reach `trusted`
without ever being "guarded" in the host sense, because nothing about a branch is guardable; the
concept doesn't apply below the entity level.

### 11a.4 `KindSpec.decisionPolicy` (governance gate)

`KindSpec.decisionPolicy.requireHumanFor?: Decision['type'][] | 'apply'` gates which decision types
require a human-tagged author. `'apply'` is shorthand for `['apply']`. **Convention: default-deny.**
An author counts as human only when the string is exactly `human:<id>` (prefix match); every other
author — including an absent one — fails the check. This is what makes `tool-gate` (only a
human-authored `decision` episode may create/upgrade an `apply` branch) and `code-review` (every
decision type is agent-editable) both real over the same episode type: the policy lives on the
kind, not the episode. A rejected episode MUST fail with a typed permission error naming the kind
and the decision type, at validation time (the same point a `signal`'s or `retract`'s invalid shape
is rejected) — never as a silent no-op.

**The gate is advisory: `human:` is a label, not an identity.** The author string is supplied by the
caller, so any caller — an agent over MCP included — can write `human:<id>`. The gate stops a writer
that follows the policy; it does not authenticate one that does not. Binding "human" to something
an agent cannot set (a signed author, an allow-list enforced outside the store) is the host's job.
Accordingly, text addressed to the writer — tool and flag descriptions, and the permission error
itself — MUST NOT instruct it to pass a `human:` author. The error SHOULD carry a hint to escalate
to a human rather than retry, while its code (`CORE_PERMISSION_DENIED`) stays the machine-readable
signal a loop branches on.

### 11a.5 Known gap: retraction does not mask `define`/`decision`

A `retract` episode (§entityKeyString / retraction semantics) masks its target for `foldEpisode`'s
trust fold and `foldLog`. It is **not** currently read by `foldDefinitions` or `foldDecisionTree` —
a `retract` targeting a bad `define` or `decision` episode's `seq` does not remove it from either
fold's output. A future spec revision should decide whether these folds should honor `retract`
symmetrically with the trust fold, or whether definitions/decisions want their own correction
mechanism (e.g. a later `define`/`decision` simply superseding, which latest-write-wins already
gives them). Until resolved, a host wanting to correct a bad definition or decision should submit a
newer one for the same key/`caseId`, not rely on `retract`.

## 11. Conformance vectors

Vectors are language-neutral JSON under `docs/spec/vectors/` (format defined with them in
medha-s7z.3). Each has `specVersion`, an input (kind spec, ordered signals/guard reports with
timestamps, `now`) and the expected trust, components, status, and gates. Numeric comparison is
exact after `round6`; ports MUST round with §1.1 rather than compare with tolerance, except where
a vector explicitly declares one.

## 12. Changing this spec

Any change that alters a vector's expected output is a **major** version bump. Additive kind-spec
fields or new signals that leave existing vectors unchanged are **minor**. Wording fixes are
**patch**.

| Version | Change |
| --- | --- |
| 1.4.0 | Decision-tree write-time validation is now normative (§11a.2): an explicitly supplied `caseId` must exist, and a `parentId` that is unknown, self-referential, or a descendant is refused, as is a sibling-duplicate condition. `detach` promotes a branch to the root, and an omitted `parentId` on an edit inherits rather than clears. Added `parentInheritance` vectors. §11a.4 states that the `human:` gate is advisory and that writer-facing text must not instruct a writer to pass it. No vector's expected trust/status output changed — hence minor. |
| 1.3.0 | Drift gained an explicit direction; quarantine is gated on drift **down** only, so an entity that is diverging *upward* is no longer quarantined. `medha sweep` no longer retires on age or recency alone. |
