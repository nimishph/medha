use medha::core::types::{LifecycleStatus, TrustHint};
use medha::SimulationReport;

/// A lifecycle status as the TypeScript CLI prints it: lowercase (`probation`, not `Probation`).
pub fn status_name(status: &LifecycleStatus) -> String {
    format!("{:?}", status).to_lowercase()
}

pub fn render_hint(hint: &TrustHint) -> String {
    format!(
        "medha: {}  trust: {:.3}  status: {}",
        hint.key.to_string_repr(),
        hint.trust,
        status_name(&hint.status)
    )
}

pub fn render_simulation(sim: &SimulationReport) -> String {
    let mut out = format!(
        "medha: simulate {} on {}\n",
        sim.signal,
        sim.key.to_string_repr()
    );
    out.push_str(&format!(
        "  trust:    {:.3} -> {:.3} (delta {:+.3})\n",
        sim.previous_trust, sim.projected_trust, sim.trust_delta
    ));
    let prev_s = format!("{:?}", sim.previous_status).to_lowercase();
    let proj_s = format!("{:?}", sim.projected_status).to_lowercase();
    out.push_str(&format!(
        "  status:   {} -> {} ({})\n",
        prev_s,
        proj_s,
        if sim.status_changed {
            "changed"
        } else {
            "unchanged"
        }
    ));
    out
}

/// The latch lines from a TypeScript-shaped `latch` object (see `render_latch`).
pub fn latch_lines_value(latch: &serde_json::Value) -> String {
    if latch.is_null() {
        return String::new();
    }
    let cause = latch["cause"].as_str().unwrap_or("");
    let by = if cause == "evidence" {
        format!(
            "by evidence ({}/{} successes)",
            n(&latch["evidence"]["k"]),
            n(&latch["evidence"]["n"])
        )
    } else {
        format!("by {cause}")
    };
    let retractable = latch["liftedBy"]
        .as_array()
        .is_some_and(|a| a.iter().any(|v| v == "retract"));
    let lift = if retractable {
        "a human restores it (medha reinstate) or retracts the failures behind it"
    } else {
        "a human restores it (medha reinstate)"
    };
    format!(
        "  latched:  {} at #{} {by}; new evidence no longer changes its status or trust\n            lifted only when {lift}\n",
        latch["status"].as_str().unwrap_or(""),
        latch["seq"]
    )
}

fn f(v: &serde_json::Value) -> String {
    crate::ts_view::fixed(v.as_f64().unwrap_or(f64::NAN))
}

fn n(v: &serde_json::Value) -> String {
    match v.as_f64() {
        Some(x) if x.fract() == 0.0 => format!("{}", x as i64),
        Some(x) => format!("{x}"),
        None => v.to_string(),
    }
}

/// `medha show`, as the TypeScript `renderShow` prints a `ShowReport`.
pub fn render_show_ts(report: &serde_json::Value) -> String {
    let d = &report["detail"];
    let h = &d["hint"];
    let key: medha::core::types::EntityKey = serde_json::from_value(report["key"].clone())
        .unwrap_or_else(|_| medha::core::types::EntityKey::new("", "rule", ""));
    let known = d["known"].as_bool() == Some(true);
    let mut out = format!(
        "medha: {} {}\n",
        crate::ts_view::key_label(&key),
        if known {
            "(known)"
        } else {
            "(unknown — probation prior)"
        }
    );
    out.push_str(&format!(
        "  status:   {}\n",
        h["status"].as_str().unwrap_or("")
    ));
    out.push_str(&latch_lines_value(&d["latch"]));
    let c = &h["components"];
    out.push_str(&format!(
        "  trust:    {}  (wilson {}, guard {}, recency {}, durability {}, ceiling {})\n",
        f(&h["trustScore"]),
        f(&c["wilson"]),
        f(&c["guard"]),
        f(&c["recency"]),
        f(&c["durability"]),
        f(&c["ceiling"])
    ));
    let e = &h["evidence"];
    out.push_str(&format!(
        "  evidence: {}/{} successes, wilson lower bound {}\n",
        n(&e["successes"]),
        n(&e["totalTrials"]),
        f(&e["lowerBound"])
    ));
    let t = &h["temporal"];
    let drifting = t["isDrifting"].as_bool() == Some(true);
    out.push_str(&format!(
        "  temporal: ema {} (baseline {}), drift {} (delta {})\n",
        f(&t["emaWeight"]),
        f(&t["baselineWeight"]),
        if drifting {
            format!("{} yes", t["driftDirection"].as_str().unwrap_or(""))
        } else {
            "no".to_string()
        },
        f(&t["driftDelta"])
    ));
    let yn = |b: &serde_json::Value| {
        if b.as_bool() == Some(true) {
            "yes"
        } else {
            "no"
        }
    };
    out.push_str(&format!(
        "  clears:   trusted {}, active {}\n",
        yn(&h["clearsThreshold"]["trusted"]),
        yn(&h["clearsThreshold"]["active"])
    ));
    if let Some(note) = h["lastNote"].as_str() {
        out.push_str(&format!("  last note: {note}\n"));
    }
    if let Some(def) = d.get("definition").filter(|v| !v.is_null()) {
        out.push_str(&format!(
            "  definition: {}\n",
            def["title"].as_str().unwrap_or("")
        ));
        if let Some(tags) = def["tags"].as_array().filter(|t| !t.is_empty()) {
            let tags: Vec<&str> = tags.iter().filter_map(|t| t.as_str()).collect();
            out.push_str(&format!("    tags:      {}\n", tags.join(", ")));
        }
        out.push_str(&format!(
            "    rationale: {}\n",
            def["rationale"].as_str().unwrap_or("")
        ));
    }
    if let Some(tree) = d["decisionTree"].as_array().filter(|t| !t.is_empty()) {
        out.push_str("  decision tree:\n");
        for line in decision_forest(tree) {
            out.push_str(&format!("    {line}\n"));
        }
    }
    if let Some(eps) = d["recentEpisodes"].as_array().filter(|a| !a.is_empty()) {
        out.push_str("  recent episodes:\n");
        let no_effect: Vec<u64> = d["noEffect"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_u64()).collect())
            .unwrap_or_default();
        for ep in eps {
            let seq = ep["seq"].as_u64().unwrap_or(0);
            let note = ep["note"]
                .as_str()
                .map(|n| format!(" — \"{n}\""))
                .unwrap_or_default();
            let effect = if no_effect.contains(&seq) {
                " (no effect: entity unknown, no --ensure)"
            } else {
                ""
            };
            out.push_str(&format!(
                "    #{seq} {} at {}{effect}{note}\n",
                ep["type"].as_str().unwrap_or(""),
                crate::ts_view::iso(ep["at"].as_i64().unwrap_or(0))
            ));
        }
    }
    if let Some(prov) = d["provenance"].as_array().filter(|a| !a.is_empty()) {
        out.push_str("  provenance:\n");
        for p in prov {
            out.push_str(&format!("    {}\n", p.as_str().unwrap_or("")));
        }
    }
    out
}

fn decision_label(decision: &serde_json::Value) -> String {
    match decision["type"].as_str() {
        Some("probability") => format!("probability({})", n(&decision["value"])),
        Some(t) => t.to_string(),
        None => String::new(),
    }
}

/// An indented forest, roots first; a parent not in the tree renders its child as a root
/// (TypeScript `renderDecisionForest`).
pub fn decision_forest(tree: &[serde_json::Value]) -> Vec<String> {
    let ids: Vec<&str> = tree.iter().filter_map(|k| k["id"].as_str()).collect();
    let parent_of = |k: &serde_json::Value| -> Option<String> {
        k["parentId"]
            .as_str()
            .filter(|p| ids.contains(p))
            .map(String::from)
    };
    let mut lines = Vec::new();
    fn walk(
        tree: &[serde_json::Value],
        parent: Option<&str>,
        depth: usize,
        parent_of: &dyn Fn(&serde_json::Value) -> Option<String>,
        lines: &mut Vec<String>,
    ) {
        for k in tree.iter().filter(|k| parent_of(k).as_deref() == parent) {
            lines.push(format!(
                "{}- {} -> {}  [{}]  k={} n={}  ({})",
                "  ".repeat(depth),
                k["condition"].as_str().unwrap_or(""),
                decision_label(&k["decision"]),
                k["status"].as_str().unwrap_or(""),
                n(&k["evidence"]["k"]),
                n(&k["evidence"]["n"]),
                k["id"].as_str().unwrap_or("")
            ));
            walk(tree, k["id"].as_str(), depth + 1, parent_of, lines);
        }
    }
    walk(tree, None, 0, &parent_of, &mut lines);
    lines
}
