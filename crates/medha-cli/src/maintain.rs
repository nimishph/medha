//! `maintain preflight|compact|backup|restore` (and the top-level `preflight`/`compact` aliases) in
//! the TypeScript CLI's shapes (`cli/src/maintain.ts`, `renderMaintain*` in `cli/src/render.ts`).

use std::fs;

use medha::store::{Episode, EpisodePayload, StorePort};
use medha::MedhaEngine;
use serde_json::{json, Value};

use crate::failure::Failure;
use crate::ts_view::iso;

type Res<T> = Result<T, Box<dyn std::error::Error>>;

/// The fold window `compact` uses when no `--older-than` is given (TypeScript `DEFAULT_FOLD_DAYS`).
const DEFAULT_FOLD_DAYS: f64 = 90.0;

pub fn preflight<S: StorePort>(engine: &MedhaEngine<S>, home: &str, now: i64) -> Res<Value> {
    let preflight = crate::read::preflight_json(engine, now)?;
    let configured = engine.store().registries().kinds.clone();
    let mut counts: Vec<(String, usize)> = Vec::new();
    for s in engine.store().list()? {
        if configured.contains(&s.key.kind) {
            continue;
        }
        match counts.iter_mut().find(|(k, _)| k == &s.key.kind) {
            Some((_, c)) => *c += 1,
            None => counts.push((s.key.kind.clone(), 1)),
        }
    }
    let mut report = json!({ "home": home, "asOf": now, "preflight": preflight });
    if !counts.is_empty() {
        report["unregisteredKinds"] = json!(counts
            .iter()
            .map(|(kind, count)| json!({ "kind": kind, "count": count }))
            .collect::<Vec<_>>());
    }
    Ok(report)
}

pub fn render_preflight(report: &Value) -> String {
    let p = &report["preflight"];
    if p["status"] == "corrupt" {
        let src = p["location"]["source"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("unknown");
        return format!(
            "medha: store at {src} is corrupt — preflight exits 1\n  hint: restore the last snapshot or inspect the store log\n"
        );
    }
    let last_sweep = p["lastSweep"]
        .as_i64()
        .map(iso)
        .unwrap_or_else(|| "not yet".into());
    let mut lines = vec![
        format!(
            "medha: preflight for {}",
            report["home"].as_str().unwrap_or("")
        ),
        format!("  status:     {}", p["status"].as_str().unwrap_or("")),
        format!("  episodes:   {}", p["episodeCount"]),
        format!("  entities:   {}", p["entityCount"]),
        format!("  integrity:  {}", p["integrity"].as_str().unwrap_or("")),
        format!(
            "  registries: {} kinds, {} signals, {} anchors",
            p["registries"]["kinds"], p["registries"]["signals"], p["registries"]["anchors"]
        ),
        format!("  last sweep: {last_sweep}"),
    ];
    for u in report["unregisteredKinds"]
        .as_array()
        .cloned()
        .unwrap_or_default()
    {
        let kind = u["kind"].as_str().unwrap_or("");
        let count = u["count"].as_u64().unwrap_or(0);
        lines.push(format!(
            "  warning:    Found {count} {} with unregistered kind '{kind}'. Data is safe. Restore '{kind}' to registries or run 'medha maintain prune --kind {kind}'.",
            if count == 1 { "entity" } else { "entities" }
        ));
    }
    format!("{}\n", lines.join("\n"))
}

pub fn is_corrupt(report: &Value) -> bool {
    report["preflight"]["status"] == "corrupt"
}

/// `--older-than` as days: a positive integer (TypeScript `positiveInt('--older-than', …)`).
pub fn older_than_days(raw: Option<f64>) -> Result<Option<f64>, Failure> {
    match raw {
        None => Ok(None),
        Some(v) if v.is_finite() && v >= 1.0 && v.fract() == 0.0 => Ok(Some(v)),
        Some(v) => Err(Failure::invalid("--older-than", "a positive integer", v)),
    }
}

pub fn compact<S: StorePort>(
    engine: &mut MedhaEngine<S>,
    home: &str,
    older_than: Option<f64>,
    now: i64,
) -> Res<Value> {
    let older_than = older_than_days(older_than)?;
    let before: Vec<Episode> = engine.store().episodes(None, None)?;
    engine.compact_older_than(now, older_than)?;
    let after: Vec<Episode> = engine.store().episodes(None, None)?;
    // Compaction folds a prefix of the log into baselines, so the folded episodes are the first
    // `before - (after - new baselines)` of the old log.
    let count_baselines = |log: &[Episode]| {
        log.iter()
            .filter(|e| matches!(e.payload, EpisodePayload::Baseline { .. }))
            .count()
    };
    let baselines = count_baselines(&after).saturating_sub(count_baselines(&before));
    let folded_n = before
        .len()
        .saturating_sub(after.len().saturating_sub(baselines));
    let folded = &before[..folded_n.min(before.len())];
    let mut entities: Vec<String> = Vec::new();
    for e in folded {
        let k = e.key.to_string_repr();
        if !entities.contains(&k) {
            entities.push(k);
        }
    }
    let compacted = match (folded.first(), folded.last()) {
        (Some(a), Some(b)) => json!({ "from": a.seq, "to": b.seq }),
        _ => Value::Null,
    };
    let days = older_than.unwrap_or(DEFAULT_FOLD_DAYS);
    Ok(json!({
        "home": home,
        "asOf": now,
        "report": {
            "compacted": compacted,
            "baselinesWritten": baselines,
            "remainingEpisodes": after.len(),
            "entities": entities.len(),
            "olderThanDays": days as i64,
        },
    }))
}

pub fn render_compact(report: &Value) -> String {
    let c = &report["report"];
    let range = match (
        c["compacted"]["from"].as_u64(),
        c["compacted"]["to"].as_u64(),
    ) {
        (Some(a), Some(b)) => format!("{a}..{b}"),
        _ => "none".to_string(),
    };
    [
        format!(
            "medha: compaction for {}",
            report["home"].as_str().unwrap_or("")
        ),
        format!("  folded range:        {range}"),
        format!("  baselines written:   {}", c["baselinesWritten"]),
        format!("  remaining episodes:  {}", c["remainingEpisodes"]),
        format!("  entities affected:   {}", c["entities"]),
        format!("  older than (days):   {}", c["olderThanDays"]),
    ]
    .join("\n")
        + "\n"
}

pub fn backup<S: StorePort>(
    engine: &MedhaEngine<S>,
    home: &str,
    registries: &Value,
    path: &str,
    now: i64,
) -> Res<Value> {
    if path.is_empty() {
        return Err(Box::new(Failure::invalid(
            "path",
            "a non-empty string path",
            "",
        )));
    }
    let snapshot = crate::init::snapshot_of(engine, registries, now)?;
    crate::init::write_snapshot(path, &snapshot)?;
    Ok(json!({ "home": home, "asOf": now, "path": path, "snapshot": snapshot }))
}

pub fn render_backup(report: &Value) -> String {
    let snap = &report["snapshot"];
    [
        format!(
            "medha: backup for {}",
            report["home"].as_str().unwrap_or("")
        ),
        format!("  written to:   {}", report["path"].as_str().unwrap_or("")),
        format!("  format:       {}", snap["format"].as_str().unwrap_or("")),
        format!(
            "  episodes:     {}",
            snap["episodes"].as_array().map(Vec::len).unwrap_or(0)
        ),
        format!(
            "  as of:        {}",
            iso(report["asOf"].as_i64().unwrap_or(0))
        ),
    ]
    .join("\n")
        + "\n"
}

fn snapshot_error(path: &str, problem: impl Into<String>) -> Failure {
    let problem = problem.into();
    Failure::cli(
        "SnapshotFileError",
        "CLI_SNAPSHOT_INVALID",
        format!("cannot read snapshot {path}: {problem}"),
    )
    .with_context(json!({ "path": path, "problem": problem }))
    .with_hint("maintain backup wrote the file; pass that path back to maintain restore")
}

/// Read a snapshot file: `maintain backup` writes `{"snapshot": …}`; a bare snapshot is accepted.
pub fn read_snapshot_file(path: &str) -> Result<medha::sync::snapshot::MemorySnapshotV1, Failure> {
    let content = fs::read_to_string(path).map_err(|e| snapshot_error(path, e.to_string()))?;
    let parsed: Value = serde_json::from_str(&content)
        .map_err(|e| snapshot_error(path, format!("invalid JSON: {e}")))?;
    if !parsed.is_object() {
        return Err(snapshot_error(path, "expected a JSON object"));
    }
    let doc = match parsed.get("snapshot") {
        Some(inner) if inner.is_object() => inner.clone(),
        _ => parsed,
    };
    if !doc.get("episodes").is_some_and(Value::is_array) {
        return Err(snapshot_error(
            path,
            "not a MedhaSnapshot (no episode log); expected the file maintain backup writes",
        ));
    }
    medha::sync::migrate_snapshot(doc).map_err(|e| snapshot_error(path, e.to_string()))
}

pub fn restore<S: StorePort>(
    engine: &mut MedhaEngine<S>,
    home: &str,
    path: &str,
    now: i64,
) -> Res<Value> {
    if path.is_empty() {
        return Err(Box::new(Failure::invalid(
            "path",
            "a non-empty string path",
            "",
        )));
    }
    let snapshot = read_snapshot_file(path)?;
    let before = engine.store().episodes(None, None)?.len();
    let episodes = snapshot.episodes.unwrap_or_default();
    let replaced = engine.store_mut().replace_log(&episodes)?;
    if let Some(meta) = snapshot.meta {
        for (k, v) in meta {
            engine.store_mut().set_meta(&k, &v)?;
        }
    }
    Ok(json!({
        "home": home,
        "asOf": now,
        "path": path,
        "restored": { "from": replaced.from, "to": replaced.to },
        "episodes": { "before": before, "after": episodes.len() },
    }))
}

pub fn render_restore(report: &Value) -> String {
    let mut lines = vec![
        format!(
            "medha: restore for {}",
            report["home"].as_str().unwrap_or("")
        ),
        format!("  source:     {}", report["path"].as_str().unwrap_or("")),
    ];
    if let Some(m) = report.get("migration") {
        lines.push(format!("  migration:  v{} -> v{}", m["from"], m["to"]));
    }
    lines.push(format!(
        "  episodes:   {} -> {}",
        report["episodes"]["before"], report["episodes"]["after"]
    ));
    format!("{}\n", lines.join("\n"))
}
