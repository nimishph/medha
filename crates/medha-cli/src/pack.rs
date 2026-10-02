use medha::core::packer::PackOutcome;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackReport {
    pub home: String,
    pub budget: usize,
    pub outcome: PackOutcome,
    pub format: String,
}

pub fn render_pack(report: &PackReport) -> String {
    let outcome = &report.outcome;
    let pct = format!("{:.1}", outcome.utilization * 100.0);

    if report.format == "compact" {
        let mut lines = vec![format!(
            "medha: packed {} entities ({}/{} tokens, {}% utilization)",
            outcome.selected.len(),
            outcome.total_cost,
            report.budget,
            pct
        )];
        if !outcome.selected.is_empty() {
            lines.push("  TRUST  STATUS     COST  ADMITTED   KEY".to_string());
            for item in &outcome.selected {
                let cost_str = format!("{}t", item.cost);
                lines.push(format!(
                    "  {:.3}  {:<9}  {:<5}  {:<9}  {}",
                    item.hint.trust,
                    format!("{:?}", item.hint.status).to_lowercase(),
                    cost_str,
                    item.admitted_by,
                    item.key.to_string_repr()
                ));
            }
        }
        return format!("{}\n", lines.join("\n"));
    }

    // Markdown format
    let mut lines = vec![
        format!(
            "# Medha Evidential Context ({} selected, {}/{} tokens, {}% utilization)",
            outcome.selected.len(),
            outcome.total_cost,
            report.budget,
            pct
        ),
        "".to_string(),
    ];

    if outcome.selected.is_empty() {
        lines.push("*No entities selected within budget.*".to_string());
    } else {
        for item in &outcome.selected {
            let tag = if item.admitted_by == "mandatory" {
                " [mandatory]"
            } else {
                ""
            };
            lines.push(format!(
                "- **`{}`** (trust: {:.3}, status: `{:?}`, cost: {}t, density: {:.3}){}",
                item.key.to_string_repr(),
                item.hint.trust,
                item.hint.status,
                item.cost,
                item.density,
                tag
            ));
        }
    }

    format!("{}\n", lines.join("\n"))
}
