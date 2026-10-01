use medha::core::types::TrustHint;
use medha::{ShowReport, SimulationReport, ThresholdExplanation};

pub fn render_hint(hint: &TrustHint) -> String {
    format!(
        "medha: {}  trust: {:.3}  status: {:?}",
        hint.key.to_string_repr(),
        hint.trust,
        hint.status
    )
}

pub fn render_show(report: &ShowReport) -> String {
    let key_repr = report.key.to_string_repr();
    let known_str = if report.known { "known" } else { "unknown" };
    let mut out = format!("medha: {} ({})\n", key_repr, known_str);
    out.push_str(&format!("  status:   {:?}\n", report.hint.status));
    out.push_str(&format!(
        "  trust:    {:.3}  (wilson {:.3}, guard {:.3}, recency {:.3}, durability {:.3}, ceiling {:.3})\n",
        report.hint.trust,
        report.hint.breakdown.wilson_lower,
        report.hint.breakdown.guard_factor,
        report.hint.breakdown.recency,
        report.hint.breakdown.durability,
        report.hint.breakdown.effective_ceiling
    ));
    out.push_str(&format!(
        "  evidence: {:.0}/{:.0} successes, wilson lower bound {:.3}\n",
        report.hint.successes, report.hint.trials, report.hint.breakdown.wilson_lower
    ));
    out.push_str(&format!(
        "  temporal: drift {} ({})\n",
        if report.hint.is_drifting { "yes" } else { "no" },
        report
            .hint
            .breakdown
            .drift_direction
            .as_deref()
            .unwrap_or("none")
    ));
    if !report.recent_episodes.is_empty() {
        out.push_str("  recent episodes:\n");
        for ep in &report.recent_episodes {
            out.push_str(&format!("    seq {}: at {}\n", ep.seq, ep.at));
        }
    }
    out
}

pub fn render_explain_threshold(expl: &ThresholdExplanation) -> String {
    let mut out = format!(
        "medha: explain thresholds for {}\n",
        expl.key.to_string_repr()
    );
    for gate in &expl.gates {
        out.push_str(&format!(
            "  {}: {}\n",
            gate.name,
            if gate.met { "MET" } else { "not met" }
        ));
        for cond in &gate.conditions {
            out.push_str(&format!(
                "    {}  {}\n",
                if cond.met { "ok" } else { "no" },
                cond.label
            ));
        }
    }
    out
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
    out.push_str(&format!(
        "  status:   {:?} -> {:?} ({})\n",
        sim.previous_status,
        sim.projected_status,
        if sim.status_changed {
            "changed"
        } else {
            "unchanged"
        }
    ));
    out
}
