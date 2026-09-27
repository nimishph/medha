#!/usr/bin/env python3
"""Independent, stdlib-only implementation of docs/spec/trust-formula.md that generates the
conformance vectors (components.json, scenarios.json).

It is written from the spec, not from the TypeScript kernel: the TS runner (medha-core
conformance test) checks that the kernel reproduces what this file computes, so the spec, this
port, and the kernel must all agree. Any port (Go, ...) can do the same against the JSON.

    python docs/spec/vectors/generate.py            # rewrite the JSON files
    python docs/spec/vectors/generate.py --check    # fail if the files are stale
"""

import json
import math
import pathlib
import sys

SPEC_VERSION = "1.2.0"
DAY_MS = 86_400_000
WEEK_MS = 7 * DAY_MS

D = dict(
    z=1.96, min_uses_trusted=5, trusted=0.6, active=0.25, unguarded_ceiling=0.5,
    half_life=45, floor=0.3, gain=0.15, dmax=1.5, alpha=0.1, min_samples_drift=3,
    drift=0.4, theta0=0.5, retired=0.1, min_uses_retired=3,
)

SIGNALS = {
    "APPLY": dict(value=1, trial=True, success=True),
    "SKIP": dict(value=0, trial=False, success=False),
    "REJECT_CONTEXT": dict(value=-0.2, trial=False, success=False),
    "REJECT_RULE": dict(value=-1, trial=True, success=False),
    "ADOPTED": dict(value=0.6, trial=True, success=True),
}


def round6(x):
    f = 10 ** 6
    s = abs(x) * f
    r = math.trunc(s) + (1 if s - math.trunc(s) >= 0.5 else 0)
    return (-r if x < 0 else r) / f


def wilson_lower(k, n, z=D["z"]):
    if n == 0:
        return 0
    p = min(1, max(0, k / n))
    z2 = z * z
    centre = p + z2 / (2 * n)
    margin = z * math.sqrt(max(0, p * (1 - p) / n) + z2 / (4 * n * n))
    lower = (centre - margin) / (1 + z2 / n)
    return round6(0 if lower < 0 else lower)


def recency(last, now, half_life=D["half_life"], floor=D["floor"]):
    if last is None:
        return floor
    age = max(0, (now - last) / DAY_MS)
    dec = math.exp(-math.log(2) * age / half_life)
    r = floor if dec < floor else dec
    return round6(1 if r > 1 else r)


def durability(h):
    if h <= 0:
        return 1
    b = 1 + D["gain"] * math.log1p(h)
    return round6(D["dmax"] if b > D["dmax"] else b)


def ema_step(mu, s, alpha=D["alpha"]):
    nxt = (0 if mu is None else mu) * (1 - alpha) + alpha * s
    return round6(min(1, max(0, nxt)))


def drift_delta(mu, theta0):
    return round6(abs(mu - theta0))


# ---------------------------------------------------------------------------------------------
# entity state / fold
# ---------------------------------------------------------------------------------------------

def unguarded(g):
    return g["kind"] in ("none", "")


def guard_factor(g):
    if unguarded(g):
        return 0.5
    if g["lastOk"] is False:
        return 0
    if g["lastOk"] is True:
        return 1
    return 0.8


def thr(ks, name, default):
    return ks.get("thresholds", {}).get(name, default)


def fresh(theta0, guard_kind, at):
    return dict(
        k=0, n=0, contextRejects=0, mu=theta0, theta0=theta0,
        guard=dict(kind=guard_kind, lastOk=None), anchors=[], status="probation",
        override=None, last=None, authors={},
    )


def n_anchors(st):
    """h: distinct anchors. Unguarded entities are handled by the caller (D = 1)."""
    return len({(a[0], a[1]) for a in st["anchors"]})


def trust_of(st, now, ks):
    un = unguarded(st["guard"])
    g = guard_factor(st["guard"])
    w = wilson_lower(st["k"], st["n"])
    rc = ks.get("recency", {})
    r = recency(st["last"], now, rc.get("halfLifeDays", D["half_life"]), rc.get("floor", D["floor"]))
    ceiling = thr(ks, "unguardedCeiling", D["unguarded_ceiling"]) if un else 1
    if st["status"] in ("quarantined", "retired"):
        return 0, dict(wilson=w, guard=g, recency=r, durability=1, ceiling=ceiling), un
    d = 1 if un else durability(n_anchors(st))
    raw = w * g * r * d
    t = round6(min(1, max(0, ceiling if raw > ceiling else raw)))
    if un and t >= ceiling:
        t = round6(ceiling - 1e-6)
    return t, dict(wilson=w, guard=g, recency=r, durability=d, ceiling=ceiling), un


def drifting(st):
    return st["n"] >= D["min_samples_drift"] and drift_delta(st["mu"], st["theta0"]) >= D["drift"]


def status_from(st, t, comps, ks):
    if st["override"] == "retired":
        return "retired"
    if st["override"] == "quarantined":
        return "quarantined"
    if st["status"] == "retired":
        return "retired"
    g = st["guard"]
    if g["kind"] not in ("none", "") and g["lastOk"] is False:
        return "quarantined"
    if drifting(st):
        return "quarantined"
    if st["n"] >= thr(ks, "minUsesForRetired", D["min_uses_retired"]) and \
            comps["wilson"] * comps["guard"] < thr(ks, "retiredTrustThreshold", D["retired"]):
        return "retired"
    if t >= thr(ks, "trusted", D["trusted"]) and \
            st["n"] >= thr(ks, "minUsesForTrusted", D["min_uses_trusted"]) and \
            st["guard"]["lastOk"] is True and not unguarded(st["guard"]):
        return "trusted"
    if t >= thr(ks, "active", D["active"]):
        return "active"
    return "probation"


def gates(st, t, ks):
    tr, mn, ac = thr(ks, "trusted", D["trusted"]), thr(ks, "minUsesForTrusted", D["min_uses_trusted"]), \
        thr(ks, "active", D["active"])
    dd = drift_delta(st["mu"], st["theta0"])
    conds = {
        "trusted": [t >= tr, st["n"] >= mn, st["guard"]["lastOk"] is True and not unguarded(st["guard"])],
        "active": [t >= ac],
        "drifting": [st["n"] >= D["min_samples_drift"], dd >= D["drift"]],
    }
    return {name: all(c) for name, c in conds.items()}


def observe(st, now, ks):
    t, comps, _ = trust_of(st, now, ks)
    status = status_from(st, t, comps, ks)
    return dict(
        trust=t, components=comps, status=status, storedStatus=st["status"], gates=gates(st, t, ks),
        driftDelta=drift_delta(st["mu"], st["theta0"]), isDrifting=drifting(st),
        evidence=dict(k=st["k"], n=st["n"], contextRejects=st["contextRejects"]),
        ema=dict(mu=st["mu"]), authors=st["authors"],
    )


def fold_signal(st, step, ks):
    spec = SIGNALS[step["signal"]]
    at = step["at"]
    st = dict(st)
    lim = ks.get("signalLimits")
    if lim is not None and spec["success"]:
        who = step.get("author", "")
        led = dict(st["authors"].get(who, dict(lastAt=None, counted=0, suppressed=0)))
        too_soon = "minIntervalMs" in lim and led["lastAt"] is not None and at - led["lastAt"] < lim["minIntervalMs"]
        over_cap = "maxSuccessesPerAuthor" in lim and led["counted"] >= lim["maxSuccessesPerAuthor"]
        st["authors"] = dict(st["authors"])
        if too_soon or over_cap:
            led["suppressed"] += 1
            st["authors"][who] = led
            return st
        led["lastAt"], led["counted"] = at, led["counted"] + 1
        st["authors"][who] = led
    if ks.get("evidenceWeighting") == "signal-value":
        tw = abs(spec["value"]) if spec["trial"] else 0
        sw = max(0, spec["value"]) if spec["success"] else 0
        st["k"], st["n"] = round6(st["k"] + sw), round6(st["n"] + tw)
    else:
        st["k"] += 1 if spec["success"] else 0
        st["n"] += 1 if spec["trial"] else 0
    if step["signal"] == "REJECT_CONTEXT":
        st["contextRejects"] += 1
    st["mu"] = ema_step(st["mu"], spec["value"])
    if spec["success"]:
        incoming = step.get("anchors") or [["week", str(at // WEEK_MS)]]
        anchors = list(st["anchors"])
        for a in incoming:
            if not any(a[0] == b[0] and a[1] == b[1] for b in anchors):
                anchors.append(list(a))
        st["anchors"] = anchors
    if step["signal"] != "SKIP":
        st["last"] = at
    # Status lag: the status is recomputed on the state that still carries the PREVIOUS status.
    t, comps, _ = trust_of(st, at, ks)
    st["status"] = status_from(st, t, comps, ks)
    return st


def fold_guard(st, step, ks):
    st = dict(st)
    st["guard"] = dict(kind=step.get("kind", st["guard"]["kind"]), lastOk=step["ok"])
    t, comps, _ = trust_of(st, step["at"], ks)
    st["status"] = status_from(st, t, comps, ks)
    return st


def run(scn):
    ks = scn.get("kindSpec", {})
    st = fresh(scn.get("theta0", D["theta0"]), scn.get("guardKind", "none"), 0)
    for step in scn["steps"]:
        st = fold_guard(st, step, ks) if "ok" in step else fold_signal(st, step, ks)
    return observe(st, scn["now"], ks)


# ---------------------------------------------------------------------------------------------
# vectors
# ---------------------------------------------------------------------------------------------

T0 = 1_700_000_000_000


def applies(n, start=T0, gap=1000):
    return [dict(signal="APPLY", at=start + i * gap) for i in range(n)]


def rejects(n, start, name="REJECT_RULE", gap=1000):
    return [dict(signal=name, at=start + i * gap) for i in range(n)]


def guard(ok, at, kind=None):
    s = dict(ok=ok, at=at)
    if kind:
        s["kind"] = kind
    return s


def scenarios():
    S = []

    def add(name, why, steps, now, **kw):
        S.append(dict(name=name, description=why, steps=steps, now=now, **kw))

    add("fresh-unguarded", "No evidence: trust 0, probation.", [], T0)
    add("fresh-guarded-unverified", "Guard declared but never reported: G=0.8, no evidence.",
        [], T0, guardKind="ci")
    add("unguarded-capped", "Unguarded entities never reach their 0.5 ceiling (Invariant IV).",
        applies(40), T0 + 41_000, theta0=0.9)
    add("guarded-trusted", "38 applies, guard passed: trusted.",
        applies(38) + [guard(True, T0 + 40_000)], T0 + 41_000, guardKind="ci", theta0=0.9)
    add("guarded-many-applies-no-guard-report", "Enough evidence but guard never reported: not trusted.",
        applies(40), T0 + 41_000, guardKind="ci", theta0=0.9)
    add("trusted-needs-min-uses", "High score but n < 5: stays active, not trusted.",
        applies(4) + [guard(True, T0 + 5000)], T0 + 6000, guardKind="ci", theta0=1.0)
    add("guard-failure-quarantines", "Failed guard -> quarantined, trust 0.",
        applies(10) + [guard(False, T0 + 20_000)], T0 + 21_000, guardKind="ci", theta0=0.9)
    add("quarantine-recovery-status-lag",
        "After a failed guard then a pass, the fold recomputes on the previous (quarantined) "
        "status so T=0 in that step: storedStatus is probation while a read at `now` derives "
        "trusted (spec section 9).",
        applies(10) + [guard(False, T0 + 20_000), guard(True, T0 + 21_000)], T0 + 22_000,
        guardKind="ci", theta0=0.9)
    add("recency-floor", "A year of idleness decays recency to the 0.3 floor.",
        applies(20) + [guard(True, T0 + 30_000)], T0 + 365 * DAY_MS, guardKind="ci", theta0=0.9)
    add("recency-half-life", "One half-life (45d) of idleness.",
        applies(20) + [guard(True, T0 + 30_000)], T0 + 45 * DAY_MS + 30_000, guardKind="ci", theta0=0.9)
    add("skip-never-refreshes-recency", "SKIP leaves n, k and lastSignalAt untouched.",
        applies(10) + [guard(True, T0 + 12_000), dict(signal="SKIP", at=T0 + 60 * DAY_MS)],
        T0 + 60 * DAY_MS, guardKind="ci", theta0=0.9)
    add("reject-context-not-a-trial", "REJECT_CONTEXT damps the EMA but no counters.",
        applies(6) + rejects(3, T0 + 10_000, "REJECT_CONTEXT") + [guard(True, T0 + 20_000)],
        T0 + 21_000, guardKind="ci", theta0=0.9)
    add("retire-by-failure", "n >= 3 and undecayed L*G < 0.1: retired.",
        rejects(6, T0) + [guard(True, T0 + 10_000)], T0 + 11_000, guardKind="ci", theta0=0.0)
    add("age-alone-never-retires", "A dormant entity is not retired by decay.",
        applies(3) + [guard(True, T0 + 5000)], T0 + 900 * DAY_MS, guardKind="ci", theta0=1.0)
    add("drift-quarantines", "Learned weight moves >= 0.4 from the baseline with n >= 3.",
        rejects(4, T0) + [guard(True, T0 + 10_000)], T0 + 11_000, guardKind="ci", theta0=0.9)
    add("durability-declared-anchors", "Distinct host anchors raise durability.",
        [dict(signal="APPLY", at=T0 + i * 1000, anchors=[["git", f"h{i}"]]) for i in range(8)]
        + [guard(True, T0 + 20_000)], T0 + 21_000, guardKind="ci", theta0=0.9)
    add("durability-week-fallback", "No anchors: one fallback anchor per calendar week.",
        [dict(signal="APPLY", at=T0 + i * WEEK_MS) for i in range(6)]
        + [guard(True, T0 + 6 * WEEK_MS)], T0 + 6 * WEEK_MS + 1000, guardKind="ci", theta0=0.9)
    add("durability-capped", "Durability saturates at 1.5.",
        [dict(signal="APPLY", at=T0 + i * 1000, anchors=[["git", f"h{i}"]]) for i in range(60)]
        + [guard(True, T0 + 70_000)], T0 + 71_000, guardKind="ci", theta0=0.9)
    add("kind-override-thresholds", "Per-kind minUsesForTrusted=50 keeps a well-evidenced entity active.",
        applies(38) + [guard(True, T0 + 40_000)], T0 + 41_000, guardKind="ci", theta0=0.9,
        kindSpec=dict(thresholds=dict(trusted=0.95, minUsesForTrusted=50)))
    add("kind-override-recency", "Per-kind half-life 10d, floor 0.5.",
        applies(20) + [guard(True, T0 + 30_000)], T0 + 30 * DAY_MS, guardKind="ci", theta0=0.9,
        kindSpec=dict(recency=dict(halfLifeDays=10, floor=0.5)))
    add("kind-override-unguarded-ceiling", "Ceiling 0.3 binds (raw ~0.456) and is clamped strictly below: 0.299999.",
        applies(40), T0 + 41_000, theta0=0.9, kindSpec=dict(thresholds=dict(unguardedCeiling=0.3)))
    add("signal-value-weighting", "Weighted evidence: ADOPTED(0.6) adds 0.6 to n and k.",
        [dict(signal="ADOPTED", at=T0 + i * 1000) for i in range(12)]
        + [dict(signal="REJECT_RULE", at=T0 + 20_000), guard(True, T0 + 21_000)],
        T0 + 22_000, guardKind="ci", theta0=0.9, kindSpec=dict(evidenceWeighting="signal-value"))
    add("mixed-history", "Applies interleaved with rejects and a late guard pass.",
        applies(15) + rejects(2, T0 + 20_000) + applies(10, T0 + 30_000)
        + [guard(True, T0 + 50_000)], T0 + 3 * DAY_MS, guardKind="ci", theta0=0.9)
    add("unguarded-guard-report-never-trusted",
        "A guard report with ok=true on an unguarded entity leaves lastOk=true, but with a low "
        "per-kind trusted threshold it must still not be trusted (found by the property test).",
        applies(12) + [guard(True, T0 + 20_000)], T0 + 21_000, theta0=0.9,
        kindSpec=dict(thresholds=dict(trusted=0.2, minUsesForTrusted=1)))
    lim = lambda **kw: dict(signalLimits=kw)
    add("limits-min-interval", "Successes from one author closer than minIntervalMs are suppressed.",
        [dict(signal="APPLY", at=T0 + t, author="a") for t in (0, 500, 999, 1000, 1500, 2100)]
        + [guard(True, T0 + 3000)], T0 + 4000, guardKind="ci", theta0=0.9, kindSpec=lim(minIntervalMs=1000))
    add("limits-max-per-author", "Each author counts at most 3 successes; a second author counts independently.",
        [dict(signal="APPLY", at=T0 + i * 1000, author="a") for i in range(10)]
        + [dict(signal="APPLY", at=T0 + 20_000 + i * 1000, author="b") for i in range(2)]
        + [guard(True, T0 + 30_000)], T0 + 31_000, guardKind="ci", theta0=0.9,
        kindSpec=lim(maxSuccessesPerAuthor=3))
    add("limits-anonymous-bucket", "Signals without an author share one anonymous bucket.",
        applies(6) + [guard(True, T0 + 10_000)], T0 + 11_000, guardKind="ci", theta0=0.9,
        kindSpec=lim(maxSuccessesPerAuthor=2))
    add("limits-never-throttle-negative", "Failures and context rejections always count.",
        [dict(signal="APPLY", at=T0, author="a"), dict(signal="APPLY", at=T0 + 1, author="a")]
        + [dict(signal="REJECT_RULE", at=T0 + 10 + i, author="a") for i in range(4)]
        + [dict(signal="REJECT_CONTEXT", at=T0 + 20 + i, author="a") for i in range(3)]
        + [guard(True, T0 + 100)], T0 + 200, guardKind="ci", theta0=0.5, kindSpec=lim(maxSuccessesPerAuthor=1))
    add("limits-suppressed-does-not-refresh-recency", "A suppressed success changes no evidence, EMA or recency.",
        [dict(signal="APPLY", at=T0, author="a"), guard(True, T0 + 1),
         dict(signal="APPLY", at=T0 + 60 * DAY_MS, author="a")],
        T0 + 60 * DAY_MS, guardKind="ci", theta0=0.9, kindSpec=lim(maxSuccessesPerAuthor=1))
    add("limits-flooding-cannot-reach-trusted", "40 successes from one author under a cap of 3 stay below trusted.",
        [dict(signal="APPLY", at=T0 + i * 1000, author="agent") for i in range(40)]
        + [guard(True, T0 + 50_000)], T0 + 51_000, guardKind="ci", theta0=0.9,
        kindSpec=lim(maxSuccessesPerAuthor=3))
    add("guard-kind-change", "A guard report may rename the guard kind; 'none' makes it unguarded.",
        applies(10) + [guard(True, T0 + 20_000, "none")], T0 + 21_000, guardKind="ci", theta0=0.9)
    return S


def components():
    wil = [[k, n] for k, n in [(0, 0), (0, 1), (1, 1), (1, 2), (5, 5), (8, 10), (38, 40), (0, 40),
                                (40, 40), (3, 7), (2.4, 4), (0.6, 0.6)]]
    rec = [[None, T0, {}], [T0, T0, {}], [T0, T0 + 45 * DAY_MS, {}], [T0, T0 + 90 * DAY_MS, {}],
           [T0, T0 + 400 * DAY_MS, {}], [T0 + 5, T0, {}],
           [T0, T0 + 20 * DAY_MS, dict(halfLifeDays=10, floor=0.5)]]
    return {
        "specVersion": SPEC_VERSION,
        "round6": [dict(input=x, expected=round6(x)) for x in
                   [0, 0.5, 1e-7, 4.9999999e-7, 5e-7, 0.1234565, -0.1234565, 2.5e-6, 0.9999995, 1 / 3, -1 / 3]],
        "wilsonLower": [dict(k=k, n=n, expected=wilson_lower(k, n)) for k, n in wil],
        "recency": [dict(lastUsedAt=a, now=b, config=c,
                         expected=recency(a, b, c.get("halfLifeDays", D["half_life"]), c.get("floor", D["floor"])))
                    for a, b, c in rec],
        "durability": [dict(h=h, expected=durability(h)) for h in [0, 1, 2, 5, 8, 20, 100, 10_000]],
        "emaStep": [dict(mu=mu, signal=s, alpha=a, expected=ema_step(mu, s, a)) for mu, s, a in
                    [(None, 1, 0.1), (0.5, 1, 0.1), (0.5, -1, 0.1), (0.05, -1, 0.1), (0.9, -0.2, 0.1),
                     (0.5, 0.6, 0.5), (0.0, 1, 1.0)]],
    }


def scenario_file():
    out = []
    for scn in scenarios():
        s = dict(scn)
        s["expected"] = run(scn)
        out.append(s)
    return {"specVersion": SPEC_VERSION, "scenarios": out}


def render(obj):
    return json.dumps(obj, indent=2, ensure_ascii=False) + "\n"


def main():
    here = pathlib.Path(__file__).parent
    files = {"components.json": render(components()), "scenarios.json": render(scenario_file())}
    if "--check" in sys.argv:
        stale = [n for n, c in files.items()
                 if not (here / n).exists() or (here / n).read_text(encoding="utf-8").replace("\r\n", "\n") != c]
        if stale:
            sys.exit(f"stale vectors: {', '.join(stale)} (run generate.py)")
        return
    for name, content in files.items():
        (here / name).write_text(content, encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
