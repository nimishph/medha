# Medha trust formula — specification

**Spec version: 1.0.0** (`TRUST_SPEC_VERSION`; conformance vectors carry the version they target.)

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
unguardedCeiling, minUsesForRetired, retiredTrustThreshold}`, `recency.{halfLifeDays, floor}`, and
`evidenceWeighting` (`'count'` default | `'signal-value'`). Overrides replace the default for that
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
4. drifting (§7) → `quarantined`.
5. `statusForTrust`:
   1. `n >= minUsesForRetired` **and** `L · G < retiredTrustThreshold` → `retired`
      (uses the *undecayed* product: age alone never retires).
   2. `T >= trusted` **and** `n >= minUsesForTrusted` **and** `guard.lastOk == true` → `trusted`.
   3. `T >= active` → `active`.
   4. otherwise `probation`.

## 7. Drift

```
emaStep(mu, s, alpha) = round6( clamp((mu ?? 0)(1−alpha) + alpha·s, 0, 1) )
driftDelta = round6(|mu − theta0|)
isDrifting = n >= MIN_SAMPLES_FOR_DRIFT and driftDelta >= DRIFT_THRESHOLD
```

## 8. Gates (`explain-threshold`, `clearsThreshold`)

There is exactly one evaluation (`evaluateGates`). A gate is met **iff every one of its conditions
is**; `clearsThreshold` and `explain-threshold` both derive from it.

| Gate | Conditions | `threshold` / `value` |
|---|---|---|
| `trusted` | `T >= trusted`; `n >= minUsesForTrusted`; `guard.lastOk == true` | trusted threshold / T |
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

## 10. Invariants a conformant port MUST preserve

- **I** Determinism: same inputs → same outputs, bit-for-bit after `round6`.
- **III** `SKIP` never changes `k`, `n`, or `lastSignalAt`.
- **IV** An unguarded entity's trust is strictly below its ceiling.
- Age or recency alone never retires an entity.
- `trusted` is unreachable without `guard.lastOk == true` and `n >= minUsesForTrusted`.
- A gate is met iff all its conditions are met.

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
