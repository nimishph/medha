//! `medha init`, as the TypeScript CLI does it (`cli/src/init.ts`, `cli/src/layout.ts`,
//! `cli/src/agent-instructions.ts`): validate `--config` strictly, build the store the backend asks
//! for, stamp the last sweep, gate on preflight, write `config.json` (store path relative to the
//! home), `.gitignore` and `README.md`, keep the agent section in AGENTS.md / CLAUDE.md, and report.
//! A second run refreshes the generated files and leaves the store alone; `--recreate` wipes it.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::args::InitArgs;
use crate::failure::Failure;

pub const CONFIG_SCHEMA_URL: &str =
    "https://raw.githubusercontent.com/nimishph/medha/main/schemas/config.v1.json";
const LAST_SWEEP_META_KEY: &str = "sweep:lastRun";
const VERSION: &str = env!("CARGO_PKG_VERSION");

pub const AGENT_SECTION: &str = "## Evidential memory: medha

This project tracks how well its rules, recipes and tools actually work in [medha](https://nimishph.github.io/medha/)
(engine home: `.medha/`). Medha reports evidence and trust hints; **you** decide what to do with them.

- Before leaning on a project rule, recipe or tool, check its trust: `medha show --id <id>` (add
  `--kind recipe|tool` for non-rules). Unknown entities are `probation`: weigh them lightly.
- `medha pack --budget 2000` gives the most trusted guidance that fits a token budget.
- After using one, record what happened: `medha record --id <id> --signal APPLY` (or
  `REJECT_RULE`, `SKIP`; `--ensure` creates a new entity).
- When a check confirms or refutes it (tests, review, audit): `medha guard --id <id> --ok|--fail --guard <kind>`.
- `medha primer [topic]` explains any of this in a few lines. If a `medha` MCP server is
  connected, its tools do the same.";

type Res<T> = Result<T, Box<dyn std::error::Error>>;

// ---------------------------------------------------------------------------------------------
// registries
// ---------------------------------------------------------------------------------------------

/// The canonical signals, in the TypeScript order and shape (`CANONICAL_SIGNALS`).
pub fn canonical_signals() -> Vec<Value> {
    vec![
        json!({ "name": "APPLY", "value": 1, "countsAsTrial": true, "countsAsSuccess": true }),
        json!({ "name": "SKIP", "value": 0, "countsAsTrial": false, "countsAsSuccess": false }),
        json!({ "name": "REJECT_CONTEXT", "value": -0.2, "countsAsTrial": false, "countsAsSuccess": false }),
        json!({ "name": "REJECT_RULE", "value": -1, "countsAsTrial": true, "countsAsSuccess": false }),
    ]
}

const BUILTIN_KINDS: [&str; 3] = ["rule", "recipe", "tool"];

/// The effective registries (TypeScript `resolveRegistries`): built-ins always present, host lists
/// additive, a kind spec merged over the bare `{name}` of every kind.
pub fn resolve_registries(host: &Value) -> Value {
    let mut kinds: Vec<String> = BUILTIN_KINDS.iter().map(|k| k.to_string()).collect();
    let host_kinds: Vec<String> = match host["kinds"].as_array() {
        Some(a) => a
            .iter()
            .filter_map(|k| k.as_str().map(String::from))
            .collect(),
        None => host["kindSpecs"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|s| s["name"].as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
    };
    for k in host_kinds {
        if !kinds.contains(&k) {
            kinds.push(k);
        }
    }
    let mut signals = canonical_signals();
    for s in host["signalSpecs"].as_array().cloned().unwrap_or_default() {
        if !signals.iter().any(|c| c["name"] == s["name"]) {
            signals.push(s);
        }
    }
    let mut anchors = vec!["week".to_string()];
    for a in host["anchorKinds"].as_array().cloned().unwrap_or_default() {
        if let Some(a) = a.as_str() {
            if !anchors.iter().any(|x| x == a) {
                anchors.push(a.to_string());
            }
        }
    }
    let mut specs: Vec<Value> = kinds.iter().map(|k| json!({ "name": k })).collect();
    for s in host["kindSpecs"].as_array().cloned().unwrap_or_default() {
        if let Some(existing) = specs.iter_mut().find(|e| e["name"] == s["name"]) {
            if let (Some(e), Some(o)) = (existing.as_object_mut(), s.as_object()) {
                for (k, v) in o {
                    e.insert(k.clone(), v.clone());
                }
            }
        } else {
            specs.push(s);
        }
    }
    json!({ "kinds": kinds, "signalSpecs": signals, "anchorKinds": anchors, "kindSpecs": specs })
}

const HOST_KEYS: &[&str] = &[
    "$schema",
    "kinds",
    "kindSpecs",
    "signalSpecs",
    "anchorKinds",
];
const KIND_SPEC_KEYS: &[&str] = &[
    "name",
    "description",
    "thresholds",
    "recency",
    "evidenceWeighting",
    "signalLimits",
    "decisionPolicy",
];
const THRESHOLD_KEYS: &[&str] = &[
    "trusted",
    "active",
    "unguardedCeiling",
    "minUsesForTrusted",
    "minUsesForRetired",
    "retiredTrustThreshold",
    "minDistinctAuthorsForRetired",
];
const RECENCY_KEYS: &[&str] = &["halfLifeDays", "floor"];
const SIGNAL_LIMIT_KEYS: &[&str] = &["minIntervalMs", "maxSuccessesPerAuthor"];
const DECISION_POLICY_KEYS: &[&str] = &["requireHumanFor"];

fn config_error(path: &str, problem: impl Into<String>) -> Failure {
    let problem = problem.into();
    Failure::cli(
        "ConfigFileError",
        "CLI_CONFIG_INVALID",
        format!("cannot read {path}: {problem}"),
    )
    .with_context(json!({ "path": path, "problem": problem }))
}

fn edit_distance(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut cur = vec![i; b.len() + 1];
        for j in 1..=b.len() {
            let sub = prev[j - 1] + usize::from(a[i - 1] != b[j - 1]);
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(sub);
        }
        prev = cur;
    }
    prev[b.len()]
}

fn closest_allowed<'a>(key: &str, allowed: &[&'a str]) -> Option<&'a str> {
    let best = allowed
        .iter()
        .map(|c| (edit_distance(&key.to_lowercase(), &c.to_lowercase()), *c))
        .min_by_key(|(d, _)| *d)?;
    (best.0 <= 2.max(key.chars().count() / 2)).then_some(best.1)
}

fn assert_known_keys(
    path: &str,
    where_: &str,
    value: &Map<String, Value>,
    allowed: &[&str],
) -> Result<(), Failure> {
    let unknown: Vec<&String> = value
        .keys()
        .filter(|k| !allowed.contains(&k.as_str()))
        .collect();
    if unknown.is_empty() {
        return Ok(());
    }
    let details: Vec<String> = unknown
        .iter()
        .map(|k| match closest_allowed(k, allowed) {
            Some(g) => format!("'{k}' (did you mean '{g}'?)"),
            None => format!("'{k}'"),
        })
        .collect();
    Err(config_error(
        path,
        format!(
            "unknown key{} in {where_}: {}; allowed: {}",
            if unknown.len() == 1 { "" } else { "s" },
            details.join(", "),
            allowed.join(", ")
        ),
    ))
}

fn assert_kind_spec_keys(
    path: &str,
    where_: &str,
    spec: &Map<String, Value>,
) -> Result<(), Failure> {
    assert_known_keys(path, where_, spec, KIND_SPEC_KEYS)?;
    for (group, allowed) in [
        ("thresholds", THRESHOLD_KEYS),
        ("recency", RECENCY_KEYS),
        ("signalLimits", SIGNAL_LIMIT_KEYS),
        ("decisionPolicy", DECISION_POLICY_KEYS),
    ] {
        if let Some(nested) = spec.get(group).and_then(|v| v.as_object()) {
            assert_known_keys(path, &format!("{where_}.{group}"), nested, allowed)?;
        }
    }
    Ok(())
}

fn invariant(message: String, spec: &Value, invariant: &str) -> Failure {
    Failure::new(
        "InvariantViolationError",
        "CORE_INVARIANT_VIOLATED",
        "core",
        message,
    )
    .with_context(json!({ "spec": spec, "invariant": invariant }))
}

/// The TypeScript `validateSignalSpec`: shape errors are invalid arguments, broken invariants are
/// `CORE_INVARIANT_VIOLATED` (not wrapped as a config-file error, as in the TypeScript CLI).
fn validate_signal_spec(spec: &Value) -> Result<(), Failure> {
    let Some(name) = spec["name"].as_str().filter(|n| !n.trim().is_empty()) else {
        return Err(Failure::invalid(
            "signal spec.name",
            "a non-empty string",
            &spec["name"],
        ));
    };
    let Some(value) = spec["value"]
        .as_f64()
        .filter(|v| v.is_finite() && (-1.0..=1.0).contains(v))
    else {
        return Err(Failure::invalid(
            "signal spec.value",
            "a finite number in [-1, 1]",
            &spec["value"],
        ));
    };
    let trial = spec["countsAsTrial"].as_bool() == Some(true);
    let success = spec["countsAsSuccess"].as_bool() == Some(true);
    if success && !trial {
        return Err(invariant(
            format!("signal '{name}' counts as success but not as a trial"),
            spec,
            "II",
        ));
    }
    if value == 0.0 && trial {
        return Err(invariant(
            format!("signal '{name}' has value 0 and counts as a trial — a neutral signal must never touch n"),
            spec,
            "III",
        ));
    }
    if trial && success && value < 0.0 {
        return Err(invariant(
            format!("signal '{name}' has a negative value but counts as a success"),
            spec,
            "IV",
        ));
    }
    Ok(())
}

/// Validate a `--config` file and return the effective registries (TypeScript
/// `effectiveRegistriesFrom`). Unknown keys are refused, naming the key and the allowed set.
pub fn registries_from_config(path: &str) -> Result<Value, Failure> {
    let text = fs::read_to_string(path).map_err(|_| config_error(path, "not valid JSON"))?;
    let parsed: Value =
        serde_json::from_str(&text).map_err(|_| config_error(path, "not valid JSON"))?;
    let Some(root) = parsed.as_object() else {
        return Err(config_error(path, "expected a JSON object"));
    };
    assert_known_keys(path, "the config root", root, HOST_KEYS)?;
    let mut kinds: Vec<String> = Vec::new();
    let mut specs: Vec<Value> = Vec::new();
    match root.get("kinds") {
        None => {}
        Some(Value::Array(items)) => {
            for item in items {
                match item {
                    Value::String(s) if !s.trim().is_empty() => {
                        kinds.push(s.clone());
                        specs.push(json!({ "name": s }));
                    }
                    Value::String(_) => {
                        return Err(config_error(
                            path,
                            "kinds must be an array of non-empty strings",
                        ))
                    }
                    Value::Object(spec) => {
                        let name = spec
                            .get("name")
                            .and_then(|n| n.as_str())
                            .filter(|n| !n.trim().is_empty());
                        let Some(name) = name else {
                            return Err(config_error(
                                path,
                                "kind spec must have a non-empty string name",
                            ));
                        };
                        assert_kind_spec_keys(path, &format!("kinds[{}]", kinds.len()), spec)?;
                        kinds.push(name.to_string());
                        specs.push(item.clone());
                    }
                    _ => {
                        return Err(config_error(
                            path,
                            "kinds must be an array of non-empty strings or KindSpec objects",
                        ));
                    }
                }
            }
        }
        Some(Value::Object(map)) => {
            for (name, raw) in map {
                let Some(spec) = raw.as_object() else {
                    return Err(config_error(
                        path,
                        format!("kind configuration for '{name}' must be an object"),
                    ));
                };
                assert_kind_spec_keys(path, &format!("kinds['{name}']"), spec)?;
                kinds.push(name.clone());
                let mut merged = Map::new();
                merged.insert("name".to_string(), json!(name));
                for (k, v) in spec {
                    merged.insert(k.clone(), v.clone());
                }
                specs.push(Value::Object(merged));
            }
        }
        Some(_) => {
            return Err(config_error(
                path,
                "kinds must be an array of non-empty strings or a configuration object",
            ));
        }
    }
    if let Some(ks) = root.get("kindSpecs") {
        let Some(arr) = ks.as_array() else {
            return Err(config_error(path, "kindSpecs must be an array"));
        };
        for (i, spec) in arr.iter().enumerate() {
            let obj = spec.as_object().filter(|o| {
                o.get("name")
                    .and_then(|n| n.as_str())
                    .is_some_and(|n| !n.trim().is_empty())
            });
            let Some(obj) = obj else {
                return Err(config_error(
                    path,
                    "each kindSpec must be an object with a non-empty name",
                ));
            };
            assert_kind_spec_keys(path, &format!("kindSpecs[{i}]"), obj)?;
            let name = obj["name"].as_str().unwrap_or_default().to_string();
            if !kinds.contains(&name) {
                kinds.push(name.clone());
            }
            if let Some(existing) = specs.iter_mut().find(|s| s["name"] == name.as_str()) {
                if let Some(e) = existing.as_object_mut() {
                    for (k, v) in obj {
                        e.insert(k.clone(), v.clone());
                    }
                }
            } else {
                specs.push(spec.clone());
            }
        }
    }
    if let Some(a) = root.get("anchorKinds") {
        let ok = a.as_array().is_some_and(|a| {
            a.iter()
                .all(|v| v.as_str().is_some_and(|s| !s.trim().is_empty()))
        });
        if !ok {
            return Err(config_error(
                path,
                "anchorKinds must be an array of non-empty strings",
            ));
        }
    }
    if let Some(s) = root.get("signalSpecs") {
        let Some(arr) = s.as_array() else {
            return Err(config_error(path, "signalSpecs must be an array"));
        };
        let mut seen: Vec<String> = Vec::new();
        let canonical = canonical_signals();
        for spec in arr {
            if !spec.is_object() {
                return Err(config_error(path, "each signalSpec must be an object"));
            }
            validate_signal_spec(spec)?;
            let name = spec["name"].as_str().unwrap_or_default().to_string();
            if let Some(b) = canonical.iter().find(|c| c["name"] == name.as_str()) {
                let same = b["value"].as_f64() == spec["value"].as_f64()
                    && b["countsAsTrial"] == spec["countsAsTrial"]
                    && b["countsAsSuccess"] == spec["countsAsSuccess"];
                if !same {
                    return Err(config_error(
                        path,
                        format!(
                            "cannot redefine built-in signal '{name}'; built-in signals have canonical semantics (expected value={}, countsAsTrial={}, countsAsSuccess={})",
                            b["value"], b["countsAsTrial"], b["countsAsSuccess"]
                        ),
                    ));
                }
            }
            if seen.contains(&name) {
                return Err(config_error(
                    path,
                    format!("signalSpecs defines '{name}' twice"),
                ));
            }
            seen.push(name);
        }
    }
    Ok(resolve_registries(&json!({
        "kinds": kinds,
        "kindSpecs": specs,
        "signalSpecs": root.get("signalSpecs").cloned().unwrap_or(json!([])),
        "anchorKinds": root.get("anchorKinds").cloned().unwrap_or(json!([])),
    })))
}

fn signal_key(s: &Value) -> String {
    format!(
        "{}|{}|{}",
        s["value"].as_f64().unwrap_or(0.0),
        u8::from(s["countsAsTrial"] == true),
        u8::from(s["countsAsSuccess"] == true)
    )
}

fn names(v: &Value) -> Vec<String> {
    let mut n: Vec<String> = v
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    n.sort();
    n.dedup();
    n
}

fn diff_names(a: &Value, b: &Value) -> (Vec<String>, Vec<String>) {
    let (sa, sb) = (names(a), names(b));
    (
        sb.iter().filter(|x| !sa.contains(x)).cloned().collect(),
        sa.iter().filter(|x| !sb.contains(x)).cloned().collect(),
    )
}

/// Registry drift between config.json (`a`) and `--config` (`b`), as the TypeScript summary.
fn registry_drift(a: &Value, b: &Value) -> Option<String> {
    let signals = |r: &Value| -> Vec<(String, String)> {
        r["signalSpecs"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|s| (s["name"].as_str().unwrap_or("").to_string(), signal_key(s)))
            .collect()
    };
    let (sa, sb) = (signals(a), signals(b));
    let (ka, kr) = diff_names(&a["kinds"], &b["kinds"]);
    let (aa, ar) = diff_names(&a["anchorKinds"], &b["anchorKinds"]);
    let mut sadd: Vec<String> = sb
        .iter()
        .filter(|(n, _)| !sa.iter().any(|(m, _)| m == n))
        .map(|(n, _)| n.clone())
        .collect();
    let mut srem: Vec<String> = sa
        .iter()
        .filter(|(n, _)| !sb.iter().any(|(m, _)| m == n))
        .map(|(n, _)| n.clone())
        .collect();
    sadd.sort();
    srem.sort();
    let changed = sa
        .iter()
        .any(|(n, k)| sb.iter().any(|(m, l)| m == n && l != k));
    if ka.is_empty()
        && kr.is_empty()
        && aa.is_empty()
        && ar.is_empty()
        && sadd.is_empty()
        && srem.is_empty()
        && !changed
    {
        return None;
    }
    let part = |added: &[String], removed: &[String]| -> Option<String> {
        let mut bits = Vec::new();
        if !added.is_empty() {
            bits.push(format!("+{}", added.join(",")));
        }
        if !removed.is_empty() {
            bits.push(format!("-{}", removed.join(",")));
        }
        (!bits.is_empty()).then(|| bits.join(" "))
    };
    Some(
        [part(&ka, &kr), part(&sadd, &srem), part(&aa, &ar)]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join("; "),
    )
}

// ---------------------------------------------------------------------------------------------
// agent instruction files
// ---------------------------------------------------------------------------------------------

fn begin_marker(version: &str) -> String {
    format!("<!-- medha:begin v{version} — managed by `medha init`; edits between these markers are replaced on the next init -->")
}
const END_MARKER: &str = "<!-- medha:end -->";

fn render_section(version: &str) -> String {
    format!(
        "{}\n{}\n{END_MARKER}",
        begin_marker(version),
        AGENT_SECTION.trim()
    )
}

/// Insert or replace the managed section; returns the new text and the version it replaced.
fn upsert_section(text: &str, version: &str) -> (String, Option<String>) {
    let crlf = text.contains("\r\n");
    let normalized = if crlf {
        text.replace("\r\n", "\n")
    } else {
        text.to_string()
    };
    let section = render_section(version);
    let found = normalized.find("<!-- medha:begin v").and_then(|start| {
        let rest = &normalized[start..];
        let head_end = rest.find("-->")?;
        let end = rest.find(END_MARKER)?;
        if end < head_end {
            return None;
        }
        let ver = rest["<!-- medha:begin v".len()..]
            .split_whitespace()
            .next()?
            .to_string();
        Some((start, start + end + END_MARKER.len(), ver))
    });
    let (next, prev) = match found {
        Some((s, e, ver)) => (
            format!("{}{}{}", &normalized[..s], section, &normalized[e..]),
            Some(ver),
        ),
        None if normalized.trim().is_empty() => (format!("{section}\n"), None),
        None => (format!("{}\n\n{section}\n", normalized.trim_end()), None),
    };
    (
        if crlf {
            next.replace('\n', "\r\n")
        } else {
            next
        },
        prev,
    )
}

fn imports_agents_file(path: &Path) -> bool {
    fs::read_to_string(path).is_ok_and(|t| {
        t.lines().any(|l| {
            let l = l.trim();
            l == "@AGENTS.md" || l == "@./AGENTS.md" || l == "@/AGENTS.md" || l == "@.AGENTS.md"
        })
    })
}

fn agent_targets(root: &Path, named: Option<&str>) -> Vec<PathBuf> {
    if let Some(n) = named {
        let p = Path::new(n);
        return vec![if p.is_absolute() {
            p.to_path_buf()
        } else {
            root.join(p)
        }];
    }
    let existing: Vec<PathBuf> = ["AGENTS.md", "CLAUDE.md"]
        .iter()
        .map(|n| root.join(n))
        .filter(|p| p.exists())
        .collect();
    if existing.is_empty() {
        return vec![root.join("AGENTS.md")];
    }
    let mut targets: Vec<PathBuf> = Vec::new();
    let mut seen: Vec<PathBuf> = Vec::new();
    for p in existing {
        let real = fs::canonicalize(&p).unwrap_or_else(|_| p.clone());
        if seen.contains(&real) {
            continue;
        }
        seen.push(real);
        if p.ends_with("CLAUDE.md") && !targets.is_empty() && imports_agents_file(&p) {
            continue;
        }
        targets.push(p);
    }
    targets
}

/// Keep the medha section in each target file; returns `{path, state, previousVersion}` results.
fn apply_agent_section(root: &Path, targets: &[PathBuf]) -> Res<Vec<Value>> {
    let mut out = Vec::new();
    for path in targets {
        let exists = path.exists();
        let before = if exists {
            fs::read_to_string(path)?
        } else {
            String::new()
        };
        let (text, prev) = upsert_section(&before, VERSION);
        let state = if !exists {
            "created"
        } else if text == before {
            "current"
        } else if prev.is_none() {
            "inserted"
        } else {
            "updated"
        };
        if state != "current" {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(path, &text)?;
        }
        let shown = path
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| path.to_string_lossy().to_string());
        out.push(json!({ "path": shown, "state": state, "previousVersion": prev }));
    }
    Ok(out)
}

fn render_agent_file(r: &Value) -> String {
    let path = r["path"].as_str().unwrap_or("");
    match r["state"].as_str() {
        Some("created") => format!("created {path} with the medha section"),
        Some("inserted") => format!("added the medha section to {path}"),
        Some("updated") => format!(
            "updated the medha section in {path} (was v{})",
            r["previousVersion"].as_str().unwrap_or("")
        ),
        _ => format!("{path}: medha section is current"),
    }
}

// ---------------------------------------------------------------------------------------------
// scaffolding
// ---------------------------------------------------------------------------------------------

const GITIGNORE_HEADER: &str = "# Written by `medha init`. Safe to edit or delete.
#
# config.json is NOT listed here: it is a small, human-authored registry definition (kinds,
# signals, thresholds), meant to be committed like any other project config file.
#
# Everything below is either local-only mechanics or data that has its own sync channel
# (`medha sync`, over a dedicated git ref or a snapshot file) — tracking it here too would
# duplicate that channel and produce merge conflicts an ordinary git merge cannot resolve.
";

fn write_gitignore(home: &Path, backend: &str, store_file: &str) -> Res<PathBuf> {
    let path = home.join(".gitignore");
    let lines = if backend == "sqlite" {
        format!(
            "# The store itself: medha sync moves this data, not ordinary commits.\n{f}\n\n# Local-only: SQLite's WAL-mode journal, regenerated and meaningless without the store above.\n{f}-wal\n{f}-shm\n{f}-journal\n",
            f = store_file
        )
    } else {
        format!(
            "# The store itself: medha sync moves this data, not ordinary commits.\n{f}\n\n# Local-only: the atomic-write backup and in-flight temp file.\n{f}.bak\n{f}.tmp\n",
            f = store_file
        )
    };
    fs::write(&path, format!("{GITIGNORE_HEADER}\n{lines}"))?;
    Ok(path)
}

fn write_readme(home: &Path, backend: &str) -> Res<PathBuf> {
    let path = home.join("README.md");
    let store = if backend == "sqlite" {
        "store.sqlite"
    } else {
        "state.jsonl"
    };
    let text = format!(
        "# .medha/

This directory is a [Medha](https://github.com/nimishph/medha) evidential-memory store, created
by `medha init`. It records what happened to your rules, recipes, and tools, and returns trust
hints — it never decides anything for you.

## What's here

- **`config.json`** — the single source of truth: backend, store path, and the registries
  (kinds, signals, thresholds). Meant to be committed; it's small and human-reviewable.
- **the store itself** (`{store}`) — the
  append-only episode log Medha folds into trust. Gitignored by default: share it with a team via
  `medha sync` (a dedicated git ref or a snapshot file), not by committing it directly. If you'd
  rather commit it as a simple, manual sync, delete or edit `.gitignore`.

## Useful commands

```sh
medha list                                # what Medha knows, ranked by trust
medha maintain preflight                  # verify store integrity and registry match
medha maintain backup snapshot.json       # atomic, portable snapshot
medha sync status                         # compare against the shared ref/file
```

Run `medha --help` for the full command surface.
"
    );
    fs::write(&path, text)?;
    Ok(path)
}

/// config.json stores the store path relative to the home with forward slashes when it can.
fn stored_path(home: &Path, absolute: &Path) -> String {
    match absolute.strip_prefix(home) {
        Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
        Err(_) => absolute.to_string_lossy().to_string(),
    }
}

fn remove_store_artifacts(backend: &str, store: &Path) {
    let s = store.to_string_lossy().to_string();
    let artifacts = if backend == "sqlite" {
        vec![s.clone(), format!("{s}-wal"), format!("{s}-shm")]
    } else {
        vec![s.clone(), format!("{s}.bak"), format!("{s}.tmp")]
    };
    for a in artifacts {
        let _ = fs::remove_file(a);
    }
}

pub fn parse_namespace_scope(raw: Option<&str>) -> Result<Option<Vec<String>>, Failure> {
    let Some(raw) = raw else { return Ok(None) };
    let mut names: Vec<String> = Vec::new();
    for n in raw.split(',').map(str::trim).filter(|n| !n.is_empty()) {
        if !names.iter().any(|x| x == n) {
            names.push(n.to_string());
        }
    }
    if names.is_empty() {
        return Err(Failure::invalid(
            "--namespace",
            "at least one non-empty namespace",
            raw,
        ));
    }
    Ok(Some(names))
}

fn read_config(home: &Path) -> Option<Value> {
    let text = fs::read_to_string(home.join(crate::CONFIG_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

/// The new store's preflight report (TypeScript shape), after stamping the last sweep.
fn bootstrap_sqlite(
    store_path: &Path,
    registries: &Value,
    now: i64,
    backup: Option<&str>,
) -> Res<Value> {
    use medha::store::StorePort;
    let regs: medha::store::StoreRegistries = serde_json::from_value(registries.clone())?;
    let mut engine = medha::MedhaEngine::open_sqlite(store_path.to_string_lossy().to_string())?;
    engine.use_registries(&regs);
    if engine.store().get_meta(LAST_SWEEP_META_KEY)?.is_none() {
        engine
            .store_mut()
            .set_meta(LAST_SWEEP_META_KEY, &now.to_string())?;
    }
    let preflight = crate::read::preflight_json(&engine, now)?;
    if preflight["status"] != "ok" {
        return Err(Box::new(
            Failure::cli(
                "StoreCorruptError",
                "CLI_STORE_CORRUPT",
                format!(
                    "store is corrupt — the log is unrecoverable from seq {}",
                    preflight["location"]["atSeq"]
                ),
            )
            .with_hint("restore a MedhaSnapshot, or wipe and re-initialize with --recreate"),
        ));
    }
    if let Some(path) = backup {
        write_snapshot(path, &snapshot_of(&engine, registries, now)?)?;
    }
    Ok(preflight)
}

/// A `MedhaSnapshot` (TypeScript `Medha#backup`).
pub fn snapshot_of<S: medha::store::StorePort>(
    engine: &medha::MedhaEngine<S>,
    registries: &Value,
    now: i64,
) -> Res<Value> {
    let mut meta = Map::new();
    for key in [LAST_SWEEP_META_KEY, "audit:removedEpisodes"] {
        if let Some(v) = engine.store().get_meta(key)? {
            meta.insert(key.to_string(), json!(v));
        }
    }
    Ok(json!({
        "format": "sutras.medha/v1",
        "formatVersion": 1,
        "exportedAt": now,
        "registries": registries,
        "episodes": engine.store().episodes(None, None)?,
        "meta": meta,
    }))
}

pub fn write_snapshot(path: &str, snapshot: &Value) -> Res<()> {
    let p = Path::new(path);
    if let Some(parent) = p.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }
    fs::write(
        p,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&json!({ "snapshot": snapshot }))?
        ),
    )?;
    Ok(())
}

/// A new file-backend document (`StoreDocumentV1`), or the preflight of an existing one.
fn bootstrap_file(
    store_path: &Path,
    registries: &Value,
    now: i64,
    backup: Option<&str>,
) -> Res<Value> {
    let doc = if store_path.exists() {
        let text = fs::read_to_string(store_path)?;
        match serde_json::from_str::<Value>(&text) {
            Ok(v) if v["episodes"].is_array() => v,
            _ => {
                return Err(Box::new(
                    Failure::cli(
                        "StoreCorruptError",
                        "CLI_STORE_CORRUPT",
                        "store is corrupt — the log is unrecoverable from seq 0",
                    )
                    .with_context(json!({ "source": store_path.display().to_string(), "atSeq": 0 }))
                    .with_hint(
                        "restore a MedhaSnapshot, or wipe and re-initialize with --recreate",
                    ),
                ));
            }
        }
    } else {
        let doc = json!({
            "layoutVersion": 1,
            "registries": registries,
            "episodes": [],
            "meta": { LAST_SWEEP_META_KEY: now.to_string() },
        });
        if let Some(parent) = store_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(
            store_path,
            format!("{}\n", serde_json::to_string_pretty(&doc)?),
        )?;
        doc
    };
    let episodes = doc["episodes"].as_array().map(Vec::len).unwrap_or(0);
    let mut entities: Vec<String> = Vec::new();
    for e in doc["episodes"].as_array().cloned().unwrap_or_default() {
        let k = format!("{}", e["key"]);
        if !entities.contains(&k) {
            entities.push(k);
        }
    }
    if let Some(path) = backup {
        write_snapshot(
            path,
            &json!({
                "format": "sutras.medha/v1",
                "formatVersion": 1,
                "exportedAt": now,
                "registries": registries,
                "episodes": doc["episodes"],
                "meta": doc["meta"],
            }),
        )?;
    }
    Ok(json!({
        "asOf": now,
        "status": "ok",
        "location": Value::Null,
        "episodeCount": episodes,
        "entityCount": entities.len(),
        "integrity": "ok",
        "danglingRetractions": [],
        "lastSweep": doc["meta"][LAST_SWEEP_META_KEY].as_str().and_then(|s| s.parse::<i64>().ok()),
        "registries": {
            "kinds": registries["kinds"].as_array().map(Vec::len).unwrap_or(0),
            "signals": registries["signalSpecs"].as_array().map(Vec::len).unwrap_or(0),
            "anchors": registries["anchorKinds"].as_array().map(Vec::len).unwrap_or(0),
        },
    }))
}

fn bootstrap(
    backend: &str,
    store: &Path,
    registries: &Value,
    now: i64,
    backup: Option<&str>,
) -> Res<Value> {
    if backend == "sqlite" {
        bootstrap_sqlite(store, registries, now, backup)
    } else {
        bootstrap_file(store, registries, now, backup)
    }
}

// ---------------------------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------------------------

pub fn run(
    args: &InitArgs,
    dir: Option<&str>,
    home_override: Option<&str>,
    now: i64,
) -> Res<Value> {
    let backend_raw = args.store.as_deref().unwrap_or(&args.backend).to_string();
    if !["sqlite", "file", "memory"].contains(&backend_raw.as_str()) {
        return Err(Box::new(Failure::invalid(
            "--store",
            "one of sqlite, file, memory",
            backend_raw,
        )));
    }
    let backend = backend_raw.as_str();
    let requested_scope = parse_namespace_scope(args.namespace.as_deref())?;
    let project = dir
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."));
    let project = std::path::absolute(&project).unwrap_or(project);
    let home = crate::home_path(Some(&project.to_string_lossy()), home_override);
    let store_path: Option<PathBuf> = if backend == "memory" {
        if let Some(p) = &args.path {
            return Err(Box::new(Failure::invalid(
                "--path",
                "no store path for the ephemeral memory backend",
                p,
            )));
        }
        None
    } else {
        Some(match &args.path {
            Some(p) => {
                let p = PathBuf::from(p);
                std::path::absolute(&p).unwrap_or(p)
            }
            None => home.join(if backend == "sqlite" {
                "store.sqlite"
            } else {
                "state.jsonl"
            }),
        })
    };
    let requested = match &args.config {
        Some(path) => registries_from_config(path)?,
        None => resolve_registries(&json!({})),
    };
    let home_str = home.display().to_string();
    let backup = args.backup.as_deref();

    let agent_files = |root: &Path| -> Res<Vec<Value>> {
        if args.no_agents_file {
            return Ok(Vec::new());
        }
        apply_agent_section(root, &agent_targets(root, args.agents_file.as_deref()))
    };

    if backend == "memory" {
        let preflight = json!({
            "asOf": now, "status": "ok", "location": Value::Null, "episodeCount": 0, "entityCount": 0,
            "integrity": "ok", "danglingRetractions": [], "lastSweep": now,
            "registries": {
                "kinds": requested["kinds"].as_array().map(Vec::len),
                "signals": requested["signalSpecs"].as_array().map(Vec::len),
                "anchors": requested["anchorKinds"].as_array().map(Vec::len),
            },
        });
        if let Some(path) = backup {
            write_snapshot(
                path,
                &json!({
                    "format": "sutras.medha/v1", "formatVersion": 1, "exportedAt": now,
                    "registries": requested, "episodes": [], "meta": { LAST_SWEEP_META_KEY: now.to_string() },
                }),
            )?;
        }
        return Ok(json!({
            "status": "initialized", "home": home_str, "backend": backend, "path": Value::Null,
            "config": Value::Null, "layoutVersion": Value::Null, "preflight": preflight,
            "registryDrift": Value::Null, "backup": backup, "namespaceScope": requested_scope,
            "gitignore": Value::Null, "readme": Value::Null, "agentFiles": [],
        }));
    }
    let store_path = store_path.expect("a persistent backend has a store path");

    if !args.recreate {
        if let Some(existing) = read_config(&home) {
            if let Some(cfg) = &args.config {
                if let Some(summary) = registry_drift(&existing["registries"], &requested) {
                    let config_path = home.join(crate::CONFIG_FILE).display().to_string();
                    return Err(Box::new(
                        Failure::cli(
                            "RegistryDriftError",
                            "CLI_REGISTRY_DRIFT",
                            format!(
                                "registries in {config_path} differ from --config ({summary}) — refusing: config.json is the single source of truth"
                            ),
                        )
                        .with_context(json!({ "configPath": config_path, "requested": cfg })),
                    ));
                }
            }
            if requested_scope.is_some() || args.no_namespace {
                let flag = if args.no_namespace {
                    "--no-namespace"
                } else {
                    "--namespace"
                };
                return Err(Box::new(Failure::invalid(
                    flag,
                    &format!("--recreate alongside it: {home_str} is already initialized"),
                    args.namespace.clone().unwrap_or_default(),
                )));
            }
            let ex_backend = existing["backend"].as_str().unwrap_or("sqlite").to_string();
            let ex_path = existing["path"].as_str().map(|p| {
                let p = Path::new(p);
                if p.is_absolute() {
                    p.to_path_buf()
                } else {
                    home.join(p)
                }
            });
            let preflight = match &ex_path {
                Some(p) => bootstrap(&ex_backend, p, &existing["registries"], now, backup)?,
                None => Value::Null,
            };
            return Ok(json!({
                "status": "existing", "home": home_str, "backend": ex_backend,
                "path": ex_path.map(|p| p.display().to_string()),
                "config": home.join(crate::CONFIG_FILE).display().to_string(),
                "layoutVersion": existing["layoutVersion"], "preflight": preflight,
                "registryDrift": Value::Null, "backup": backup,
                "namespaceScope": existing.get("namespaceScope").cloned().unwrap_or(Value::Null),
                "gitignore": Value::Null, "readme": Value::Null, "agentFiles": agent_files(&project)?,
            }));
        }
    }

    // --namespace wins; --no-namespace drops; otherwise --recreate carries the old scope over.
    let scope: Option<Vec<String>> = match (&requested_scope, args.no_namespace) {
        (Some(_), true) => {
            return Err(Box::new(Failure::invalid(
                "--no-namespace",
                "no --namespace alongside it (they contradict)",
                args.namespace.clone().unwrap_or_default(),
            )));
        }
        (Some(s), false) => Some(s.clone()),
        (None, true) => None,
        (None, false) if args.recreate => read_config(&home).and_then(|c| {
            c["namespaceScope"].as_array().map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
        }),
        (None, false) => None,
    };
    if args.recreate {
        remove_store_artifacts(backend, &store_path);
    }
    fs::create_dir_all(&home)?;
    let preflight = bootstrap(backend, &store_path, &requested, now, backup)?;

    let mut config = json!({
        "$schema": CONFIG_SCHEMA_URL,
        "layoutVersion": 1,
        "backend": backend,
        "path": stored_path(&home, &store_path),
    });
    if let Some(s) = &scope {
        config["namespaceScope"] = json!(s);
    }
    config["registries"] = requested.clone();
    let config_path = home.join(crate::CONFIG_FILE);
    fs::write(
        &config_path,
        format!("{}\n", serde_json::to_string_pretty(&config)?),
    )?;
    let store_file = store_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let gitignore = write_gitignore(&home, backend, &store_file)?;
    let readme = write_readme(&home, backend)?;
    Ok(json!({
        "status": if args.recreate { "recreated" } else { "initialized" },
        "home": home_str, "backend": backend, "path": store_path.display().to_string(),
        "config": config_path.display().to_string(), "layoutVersion": 1, "preflight": preflight,
        "registryDrift": Value::Null, "backup": backup, "namespaceScope": scope,
        "gitignore": gitignore.display().to_string(), "readme": readme.display().to_string(),
        "agentFiles": agent_files(&project)?,
    }))
}

/// Human output (TypeScript `renderInit`).
pub fn render(report: &Value) -> String {
    let p = &report["preflight"];
    let last_sweep = p["lastSweep"]
        .as_i64()
        .map(crate::ts_view::iso)
        .unwrap_or_else(|| "not yet".into());
    let home = report["home"].as_str().unwrap_or("");
    let mut lines = vec![
        if report["status"] == "existing" {
            format!("medha: engine home at {home} is already initialized; store left as it is")
        } else {
            format!(
                "medha: {} engine home at {home}",
                report["status"].as_str().unwrap_or("")
            )
        },
        format!("  backend:    {}", report["backend"].as_str().unwrap_or("")),
        match report["path"].as_str() {
            Some(path) => format!("  store:      {path}"),
            None => "  store:      ephemeral (memory)".to_string(),
        },
    ];
    if let Some(c) = report["config"].as_str() {
        lines.push(format!(
            "  config:     {c} (layout v{})",
            report["layoutVersion"]
        ));
    }
    lines.push(format!(
        "  preflight:  {} — {} episodes, {} entities, integrity {}",
        p["status"].as_str().unwrap_or(""),
        p["episodeCount"],
        p["entityCount"],
        p["integrity"].as_str().unwrap_or("")
    ));
    lines.push(format!("  last sweep: {last_sweep}"));
    if let Some(b) = report["backup"].as_str() {
        lines.push(format!("  backup:     {b}"));
    }
    if let Some(ns) = report["namespaceScope"].as_array() {
        let ns: Vec<&str> = ns.iter().filter_map(|v| v.as_str()).collect();
        lines.push(format!(
            "  namespaces: {} (engine restricted; maintenance sees all)",
            ns.join(", ")
        ));
    }
    if let Some(g) = report["gitignore"].as_str() {
        lines.push(format!("  gitignore:  {g}"));
    }
    if let Some(r) = report["readme"].as_str() {
        lines.push(format!("  readme:     {r}"));
    }
    for f in report["agentFiles"].as_array().cloned().unwrap_or_default() {
        lines.push(format!("  agents:     {}", render_agent_file(&f)));
    }
    format!("{}\n", lines.join("\n"))
}
