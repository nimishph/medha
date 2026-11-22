//! Write commands (`propose`, `record`, `guard`, `retract`, `reinstate`, `remove-episode`) in the
//! TypeScript CLI's shapes (`cli/src/write.ts`).

use medha::core::types::EntityKey;
use medha::store::StorePort;
use medha::{GuardInput, MedhaEngine, ProposeInput, RecordInput};
use serde_json::{json, Value};

use crate::args::{
    GuardArgs, ProposeArgs, RecordArgs, ReinstateArgs, RemoveEpisodeArgs, RetractArgs,
};
use crate::failure::{self, Failure};
use crate::ts_view::{self, fixed, key_json, key_label};

type Res<T> = Result<T, Box<dyn std::error::Error>>;

/// `--at`: epoch ms or an ISO 8601 string; absent means now (TypeScript `parseTimestamp`).
pub fn parse_timestamp(raw: Option<&str>, now: i64) -> Result<i64, Failure> {
    let Some(raw) = raw.filter(|r| !r.is_empty()) else {
        return Ok(now);
    };
    if let Ok(n) = raw.trim().parse::<f64>() {
        if n.is_finite() && n > 0.0 {
            return Ok(n.floor() as i64);
        }
    }
    parse_iso(raw)
        .ok_or_else(|| Failure::invalid("--at", "a valid ISO 8601 string or epoch ms", raw))
}

/// A small ISO 8601 parser: `YYYY-MM-DD`, optionally `THH:MM[:SS[.mmm]]` and `Z` or `±HH:MM`.
fn parse_iso(raw: &str) -> Option<i64> {
    let s = raw.trim();
    let (date, rest) = match s.find(['T', ' ']) {
        Some(i) => (&s[..i], &s[i + 1..]),
        None => (s, ""),
    };
    let mut d = date.split('-');
    let y: i64 = d.next()?.parse().ok()?;
    let mo: i64 = d.next()?.parse().ok()?;
    let da: i64 = d.next()?.parse().ok()?;
    if d.next().is_some() || !(1..=12).contains(&mo) || !(1..=31).contains(&da) {
        return None;
    }
    let (time, offset_ms) = if rest.is_empty() {
        ("00:00:00", 0)
    } else if let Some(t) = rest.strip_suffix('Z') {
        (t, 0)
    } else if let Some(i) = rest.rfind(['+', '-']).filter(|&i| i >= 5) {
        let (t, off) = rest.split_at(i);
        let sign = if off.starts_with('-') { -1 } else { 1 };
        let mut parts = off[1..].split(':');
        let oh: i64 = parts.next()?.parse().ok()?;
        let om: i64 = parts.next().unwrap_or("0").parse().ok()?;
        (t, sign * (oh * 3600 + om * 60) * 1000)
    } else {
        // No zone: JavaScript reads a date-time as local time; UTC keeps this deterministic.
        (rest, 0)
    };
    let mut t = time.split(':');
    let h: i64 = t.next()?.parse().ok()?;
    let mi: i64 = t.next().unwrap_or("0").parse().ok()?;
    let sec_str = t.next().unwrap_or("0");
    let (sec, ms) = match sec_str.split_once('.') {
        Some((a, b)) => (
            a.parse::<i64>().ok()?,
            format!("{b:0<3}")[..3].parse::<i64>().ok()?,
        ),
        None => (sec_str.parse::<i64>().ok()?, 0),
    };
    // Days from civil (Howard Hinnant).
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + da - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400 + h * 3600 + mi * 60 + sec) * 1000 + ms) - offset_ms)
}

/// The author: `--author`, else `$MEDHA_AUTHOR`, `$USER`, `$USERNAME` (TypeScript `resolveAuthor`).
pub fn resolve_author(explicit: Option<&str>) -> Option<String> {
    if let Some(a) = explicit.map(str::trim).filter(|a| !a.is_empty()) {
        return Some(a.to_string());
    }
    ["MEDHA_AUTHOR", "USER", "USERNAME"]
        .iter()
        .filter_map(|v| std::env::var(v).ok())
        .find(|v| !v.is_empty())
}

fn require_kind<S: StorePort>(engine: &MedhaEngine<S>, kind: &str) -> Result<(), Failure> {
    let kinds = &engine.store().registries().kinds;
    if kinds.iter().any(|k| k == kind) {
        Ok(())
    } else {
        Err(Failure::new(
            "UnknownKindError",
            failure::UNKNOWN_REGISTRY_ENTRY,
            "core",
            format!("Unknown kind '{kind}'"),
        )
        .with_context(json!({ "kind": "kind", "name": kind, "entries": kinds })))
    }
}

fn non_empty<'a>(name: &str, expected: &str, v: Option<&'a str>) -> Result<&'a str, Failure> {
    match v {
        Some(s) if !s.trim().is_empty() => Ok(s),
        other => Err(Failure::invalid(
            name,
            expected,
            other.unwrap_or("undefined"),
        )),
    }
}

fn seq_arg(raw: Option<&str>) -> Result<u64, Failure> {
    let raw = match raw {
        Some(r) if !r.is_empty() => r,
        _ => {
            return Err(Failure::invalid(
                "--seq",
                "an episode sequence number",
                "undefined",
            ))
        }
    };
    match raw.trim().parse::<f64>() {
        Ok(v) if v.fract() == 0.0 && v >= 0.0 => Ok(v as u64),
        _ => Err(Failure::invalid("--seq", "a non-negative integer", raw)),
    }
}

fn trust_line(hint: &Value) -> String {
    format!(
        "  trust:    {}  status: {}",
        fixed(hint["trustScore"].as_f64().unwrap_or(0.0)),
        hint["status"].as_str().unwrap_or("")
    )
}

pub fn propose<S: StorePort>(
    engine: &mut MedhaEngine<S>,
    home: &str,
    key: EntityKey,
    args: &ProposeArgs,
    now: i64,
) -> Res<Value> {
    let source = non_empty(
        "--source",
        "a non-empty proposal source",
        args.source.as_deref(),
    )?;
    require_kind(engine, &key.kind)?;
    let at = parse_timestamp(args.at.as_deref(), now)?;
    let refs: Vec<String> = args
        .evidence
        .as_deref()
        .unwrap_or("")
        .split(',')
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty())
        .collect();
    let outcome = engine.propose_with(ProposeInput {
        key: key.clone(),
        provenance: source.to_string(),
        theta0: args.theta0,
        description: args.description.clone().or_else(|| args.text.clone()),
        evidence_refs: if refs.is_empty() { None } else { Some(refs) },
        author: resolve_author(args.author.as_deref()),
        note: args.note.clone(),
        at,
    })?;
    let hint = ts_view::hint(engine, &key, at)?;
    let mut report = json!({
        "home": home,
        "key": key_json(&key),
        "promoted": outcome.promoted,
        "promotionReason": outcome.promotion_reason,
        "provenances": outcome.provenances,
        "hint": hint,
    });
    if let Some(n) = &args.note {
        report["note"] = json!(n);
    }
    Ok(report)
}

pub fn render_propose(r: &Value, key: &EntityKey) -> String {
    let mut lines = vec![format!(
        "medha: proposed {} ({})",
        key_label(key),
        if r["promoted"] == json!(true) {
            "promoted"
        } else {
            "not promoted"
        }
    )];
    if let Some(reason) = r["promotionReason"].as_str() {
        lines.push(format!("  reason:   {reason}"));
    }
    if let Some(n) = r["note"].as_str() {
        lines.push(format!("  note:     {n}"));
    }
    lines.push(trust_line(&r["hint"]));
    format!("{}\n", lines.join("\n"))
}

pub fn record<S: StorePort>(
    engine: &mut MedhaEngine<S>,
    home: &str,
    key: EntityKey,
    args: &RecordArgs,
    now: i64,
) -> Res<Value> {
    non_empty(
        "--signal",
        "a registered signal name",
        Some(args.signal.as_str()),
    )?;
    if let Some(u) = args.updater.as_deref().filter(|u| !u.is_empty()) {
        if u != "ema" {
            return Err(Box::new(
                Failure::cli(
                    "UpdaterNotFoundError",
                    "CLI_UPDATER_UNKNOWN",
                    format!("no updater named '{u}'"),
                )
                .with_context(json!({ "name": u, "known": ["ema"] }))
                .with_hint("known updaters: ema"),
            ));
        }
    }
    require_kind(engine, &key.kind)?;
    let at = parse_timestamp(args.at.as_deref(), now)?;
    let res = engine.record(RecordInput {
        key: key.clone(),
        signal: args.signal.clone(),
        at,
        ensure: args.ensure,
        author: resolve_author(args.author.as_deref()),
        anchors: None,
        run_ref: args.run_ref.clone(),
        note: args.note.clone(),
        case_id: args.case_id.clone(),
    })?;
    let hint = ts_view::hint(engine, &key, at)?;
    let mut report = json!({
        "home": home,
        "key": key_json(&key),
        "signal": args.signal,
        "recorded": res.state.is_some(),
        "hint": hint,
    });
    if let Some(n) = &args.note {
        report["note"] = json!(n);
    }
    if let Some(c) = &args.case_id {
        report["caseId"] = json!(c);
    }
    Ok(report)
}

pub fn render_record(r: &Value, key: &EntityKey) -> String {
    let head = if r["recorded"] == json!(true) {
        format!(
            "medha: recorded {} on {}",
            r["signal"].as_str().unwrap_or(""),
            key_label(key)
        )
    } else {
        format!(
            "medha: NOT recorded — {} is unknown (pass --ensure to create it)",
            key_label(key)
        )
    };
    let mut lines = vec![head, trust_line(&r["hint"])];
    if let Some(n) = r["note"].as_str() {
        lines.push(format!("  note:     {n}"));
    }
    if let Some(c) = r["caseId"].as_str() {
        lines.push(format!(
            "  branch:   {c} (branch trust learns too, not just the rule)"
        ));
    }
    format!("{}\n", lines.join("\n"))
}

pub fn guard<S: StorePort>(
    engine: &mut MedhaEngine<S>,
    home: &str,
    key: EntityKey,
    args: &GuardArgs,
    now: i64,
) -> Res<Value> {
    if args.ok == args.fail {
        return Err(Box::new(Failure::invalid(
            "--ok/--fail",
            "exactly one of --ok or --fail",
            "both or none",
        )));
    }
    require_kind(engine, &key.kind)?;
    let at = parse_timestamp(args.at.as_deref(), now)?;
    let kind = args
        .guard_kind
        .as_deref()
        .map(str::trim)
        .filter(|g| !g.is_empty());
    if kind.is_none() {
        // A report without --guard falls back to the entity's guard; with none it would not count
        // while printing "guard passed" (gh-17), so it is refused.
        let unguarded = engine
            .get(&key)?
            .is_none_or(|s| s.guard.kind.is_empty() || s.guard.kind == "none");
        if unguarded {
            return Err(Box::new(
                Failure::invalid("--guard", "a guard kind (e.g. ci, review, tests)", "undefined").with_hint(format!(
                    "{} has no guard yet, so a report without --guard would not count. Pass --guard <kind> naming the check that ran.",
                    key_label(&key)
                )),
            ));
        }
    }
    engine.guard(GuardInput {
        key: key.clone(),
        ok: args.ok,
        kind: kind.map(String::from),
        at,
        author: resolve_author(args.author.as_deref()),
        note: args.note.clone(),
    })?;
    let hint = ts_view::hint(engine, &key, at)?;
    let mut report = json!({ "home": home, "key": key_json(&key), "ok": args.ok, "hint": hint });
    if let Some(n) = &args.note {
        report["note"] = json!(n);
    }
    Ok(report)
}

pub fn render_guard(r: &Value, key: &EntityKey) -> String {
    let mut lines = vec![
        format!(
            "medha: guard {} on {}",
            if r["ok"] == json!(true) {
                "passed"
            } else {
                "failed"
            },
            key_label(key)
        ),
        trust_line(&r["hint"]),
    ];
    if let Some(n) = r["note"].as_str() {
        lines.push(format!("  note:     {n}"));
    }
    format!("{}\n", lines.join("\n"))
}

pub fn retract<S: StorePort>(
    engine: &mut MedhaEngine<S>,
    home: &str,
    args: &RetractArgs,
    now: i64,
) -> Res<Value> {
    let target = seq_arg(args.seq.as_deref())?;
    let reason = non_empty(
        "--reason",
        "a non-empty reason for retraction",
        args.reason.as_deref(),
    )?;
    let at = parse_timestamp(args.at.as_deref(), now)?;
    let expect = match &args.id {
        Some(id) => Some(crate::key_from(&args.namespace, &args.kind, id)?),
        None => None,
    };
    let outcome = engine.retract_checked_by(
        target,
        reason,
        at,
        expect.as_ref(),
        resolve_author(args.author.as_deref()),
    )?;
    let key = outcome.appended.episode.key.clone();
    let hint = ts_view::hint(engine, &key, at)?;
    let mut report = json!({
        "home": home,
        "targetSeq": target,
        "reason": reason,
        "seq": outcome.appended.episode.seq,
        "episode": outcome.appended.episode,
        "hint": hint,
    });
    if let Some(l) = &outcome.lifted {
        report["lifted"] = json!({
            "from": crate::render::status_name(&l.from),
            "to": crate::render::status_name(&l.to),
        });
    }
    Ok(report)
}

pub fn render_retract(r: &Value) -> String {
    format!(
        "medha: retracted episode #{} (recorded as #{})\n  reason:   {}\n{}\n",
        r["targetSeq"],
        r["seq"],
        r["reason"].as_str().unwrap_or(""),
        trust_line(&r["hint"])
    )
}

pub fn retract_warning(r: &Value) -> Option<String> {
    let lifted = r.get("lifted")?;
    let key: EntityKey = serde_json::from_value(r["hint"]["key"].clone()).ok()?;
    Some(format!(
        "medha: warning: this retraction took {} out of {} (now {}). Lifting a latch is a human decision, and medha cannot tell who ran this; 'medha reinstate --reason' records it as one.",
        key_label(&key),
        lifted["from"].as_str().unwrap_or(""),
        lifted["to"].as_str().unwrap_or("")
    ))
}

pub fn reinstate<S: StorePort>(
    engine: &mut MedhaEngine<S>,
    home: &str,
    key: EntityKey,
    args: &ReinstateArgs,
    now: i64,
) -> Res<Value> {
    let reason = non_empty(
        "--reason",
        "why the latch is being lifted",
        args.reason.as_deref(),
    )?;
    require_kind(engine, &key.kind)?;
    let at = parse_timestamp(args.at.as_deref(), now)?;
    let known = engine.get(&key)?.is_some();
    let latch = if known { engine.latch_of(&key)? } else { None };
    let Some(latch) = latch else {
        let status = ts_view::hint(engine, &key, at)?["status"]
            .as_str()
            .unwrap_or("")
            .to_string();
        return Err(Box::new(
            Failure::invalid(
                "--id",
                "a latched entity (retired, or quarantined by an override)",
                format!("{} is {status}", key_label(&key)),
            )
            .with_hint(if known {
                "nothing to lift: a guard or drift quarantine lifts by itself when its cause clears"
            } else {
                "no such entity"
            }),
        ));
    };
    let (_, appended) = engine.reinstate(&key, reason, at)?;
    let hint = ts_view::hint(engine, &key, at)?;
    Ok(json!({
        "home": home,
        "key": key_json(&key),
        "latch": latch,
        "seq": appended.episode.seq,
        "hint": hint,
    }))
}

pub fn render_reinstate(r: &Value, key: &EntityKey) -> String {
    let status = r["hint"]["status"].as_str().unwrap_or("");
    let mut lines = vec![
        format!(
            "medha: reinstated {} (was {} since #{}; recorded as #{})",
            key_label(key),
            r["latch"]["status"].as_str().unwrap_or(""),
            r["latch"]["seq"],
            r["seq"]
        ),
        trust_line(&r["hint"]),
    ];
    if status == "retired" || status == "quarantined" {
        lines.push(format!(
            "  note:     the evidence still makes it {status}; the next episode stores that"
        ));
    }
    format!("{}\n", lines.join("\n"))
}

pub fn remove_episode<S: StorePort>(
    engine: &mut MedhaEngine<S>,
    home: &str,
    args: &RemoveEpisodeArgs,
    now: i64,
) -> Res<Value> {
    let seq = seq_arg(args.seq.as_deref())?;
    let removed =
        engine.remove_episode_with_audit(seq, args.author.clone(), args.reason.clone(), now)?;
    let remaining = engine.store().episodes(None, None)?.len();
    Ok(json!({ "home": home, "seq": seq, "removed": removed, "remainingCount": remaining }))
}

pub fn render_remove_episode(r: &Value) -> String {
    if r["removed"] == json!(true) {
        format!(
            "medha: removed episode #{} from log ({} episodes remaining)\n",
            r["seq"], r["remainingCount"]
        )
    } else {
        format!(
            "medha: episode #{} was not found in log ({} episodes remaining)\n",
            r["seq"], r["remainingCount"]
        )
    }
}

pub fn decision<S: StorePort>(
    engine: &mut MedhaEngine<S>,
    home: &str,
    key: EntityKey,
    args: &crate::args::DecisionArgs,
    now: i64,
) -> Res<Value> {
    use medha::core::decision::Decision;
    non_empty(
        "--condition",
        "a non-empty string",
        Some(args.condition.as_str()),
    )?;
    let chosen = [args.apply, args.ignore, args.probability.is_some()]
        .iter()
        .filter(|b| **b)
        .count();
    if chosen != 1 {
        return Err(Box::new(Failure::invalid(
            "--apply/--ignore/--probability",
            "exactly one of --apply, --ignore, or --probability",
            if chosen == 0 {
                "none given"
            } else {
                "more than one given"
            },
        )));
    }
    let decision = if args.apply {
        Decision::Apply
    } else if args.ignore {
        Decision::Ignore
    } else {
        let p = args.probability.unwrap_or(f64::NAN);
        if !(p.is_finite() && (0.0..=1.0).contains(&p)) {
            return Err(Box::new(Failure::invalid(
                "--probability",
                "a number in [0,1]",
                p,
            )));
        }
        Decision::Probability { value: p }
    };
    require_kind(engine, &key.kind)?;
    if args.detach && args.parent.is_some() {
        return Err(Box::new(Failure::invalid(
            "--detach/--parent",
            "not both (--detach means \"move to the top level\")",
            format!(
                "{{\"detach\":true,\"parent\":\"{}\"}}",
                args.parent.as_deref().unwrap_or("")
            ),
        )));
    }
    let at = parse_timestamp(args.at.as_deref(), now)?;
    let (_, case_id) = engine.decision_with(medha::DecisionInput {
        key: key.clone(),
        case_id: args.case_id.clone(),
        parent_id: args.parent.clone(),
        detach: args.detach,
        condition: args.condition.clone(),
        decision: decision.clone(),
        author: resolve_author(args.author.as_deref()),
        at,
    })?;
    let mut report = json!({ "home": home, "key": key_json(&key), "caseId": case_id });
    // The effective parent when it was given or detached; an edit that omits it keeps the old one.
    if args.detach {
        report["parentId"] = Value::Null;
    } else if let Some(p) = &args.parent {
        report["parentId"] = json!(p);
    }
    report["condition"] = json!(args.condition);
    report["decision"] = serde_json::to_value(&decision)?;
    Ok(report)
}

pub fn render_decision(r: &Value, key: &EntityKey) -> String {
    let d = &r["decision"];
    let label = match d["type"].as_str() {
        Some("probability") => format!("probability({})", d["value"]),
        Some(t) => t.to_string(),
        None => String::new(),
    };
    let mut lines = vec![format!(
        "medha: decision case {} on {}",
        r["caseId"].as_str().unwrap_or(""),
        key_label(key)
    )];
    if let Some(p) = r["parentId"].as_str() {
        lines.push(format!("  parent:    {p}"));
    }
    lines.push(format!(
        "  condition: {}",
        r["condition"].as_str().unwrap_or("")
    ));
    lines.push(format!("  decision:  {label}"));
    format!("{}\n", lines.join("\n"))
}
