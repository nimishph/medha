use medha::core::guard::guard_factor;
use medha::core::thresholds::{
    ACTIVE_THRESHOLD, DEFAULT_EMA_ALPHA, DEFAULT_THETA0, DRIFT_THRESHOLD, DURABILITY_MAX,
    MIN_SAMPLES_FOR_DRIFT, MIN_USES_FOR_RETIRED, MIN_USES_FOR_TRUSTED, RECENCY_FLOOR,
    RECENCY_HALF_LIFE_DAYS, RETIRED_TRUST_THRESHOLD, TRUSTED_THRESHOLD, UNGUARDED_TRUST_CEILING,
    WILSON_Z,
};
use medha::core::types::GuardState;
use medha::core::{canonical_signals, wilson_lower_bound};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrimerTopicItem {
    pub name: String,
    pub title: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrimerResult {
    pub topic: String,
    pub title: String,
    pub description: String,
    pub content: String,
    #[serde(rename = "lineCount")]
    pub line_count: usize,
    #[serde(rename = "availableTopics")]
    pub available_topics: Vec<PrimerTopicItem>,
}

/// One primer topic, as written in `cli/src/primer-topics.ts` (the single source both CLIs render).
#[derive(Deserialize)]
struct TopicTemplate {
    name: String,
    title: String,
    description: String,
    template: String,
}

/// Synced from the TypeScript source by `bun run plugin:sync`; `tooling/plugin.test.ts` fails when
/// this copy is stale. Every number in it is a `{{NAME}}` placeholder filled by [`primer_values`].
const TOPICS_JSON: &str = include_str!("primer_topics.json");

fn topics() -> Vec<TopicTemplate> {
    serde_json::from_str(TOPICS_JSON).expect("primer_topics.json is valid (synced by plugin:sync)")
}

/// The value of every placeholder, from this kernel's constants and functions. The TypeScript CLI
/// fills the same names from its kernel (`primerValues` in cli/src/primer.ts).
fn primer_values() -> HashMap<&'static str, String> {
    let signals = canonical_signals();
    let signal = |name: &str| signals.get(name).map(|s| s.value).unwrap_or_default();
    let guard = |kind: &str, last_ok: Option<bool>| {
        guard_factor(&GuardState {
            kind: kind.to_string(),
            last_ok,
            last_ok_at: None,
        })
    };
    let wilson = |k: f64, n: f64| wilson_lower_bound(k, n, WILSON_Z).unwrap_or_default();
    HashMap::from([
        ("ACTIVE_THRESHOLD", ACTIVE_THRESHOLD.to_string()),
        ("TRUSTED_THRESHOLD", TRUSTED_THRESHOLD.to_string()),
        ("MIN_USES_FOR_TRUSTED", MIN_USES_FOR_TRUSTED.to_string()),
        (
            "UNGUARDED_TRUST_CEILING",
            UNGUARDED_TRUST_CEILING.to_string(),
        ),
        (
            "RETIRED_TRUST_THRESHOLD",
            RETIRED_TRUST_THRESHOLD.to_string(),
        ),
        ("MIN_USES_FOR_RETIRED", MIN_USES_FOR_RETIRED.to_string()),
        ("DRIFT_THRESHOLD", DRIFT_THRESHOLD.to_string()),
        ("MIN_SAMPLES_FOR_DRIFT", MIN_SAMPLES_FOR_DRIFT.to_string()),
        ("DEFAULT_EMA_ALPHA", DEFAULT_EMA_ALPHA.to_string()),
        ("DEFAULT_THETA0", DEFAULT_THETA0.to_string()),
        ("RECENCY_HALF_LIFE_DAYS", RECENCY_HALF_LIFE_DAYS.to_string()),
        ("RECENCY_FLOOR", RECENCY_FLOOR.to_string()),
        ("DURABILITY_MAX", DURABILITY_MAX.to_string()),
        ("WILSON_Z", WILSON_Z.to_string()),
        ("L_2_OF_2", format!("{:.2}", wilson(2.0, 2.0))),
        ("L_200_OF_200", format!("{:.2}", wilson(200.0, 200.0))),
        ("G_PASSED", guard("ci", Some(true)).to_string()),
        ("G_UNVERIFIED", guard("ci", None).to_string()),
        ("G_NONE", guard("none", None).to_string()),
        ("G_FAILED", guard("ci", Some(false)).to_string()),
        ("APPLY_VALUE", signal("APPLY").to_string()),
        ("REJECT_RULE_VALUE", signal("REJECT_RULE").to_string()),
        ("SKIP_VALUE", signal("SKIP").to_string()),
        ("REJECT_CONTEXT_VALUE", signal("REJECT_CONTEXT").to_string()),
    ])
}

/// Fill `{{NAME}}` placeholders; an unknown name is left as written, for the test to catch.
fn fill(template: &str, values: &HashMap<&'static str, String>) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find("}}") {
            Some(end) => {
                let name = &after[..end];
                match values.get(name) {
                    Some(value) => out.push_str(value),
                    None => out.push_str(&rest[start..start + 2 + end + 2]),
                }
                rest = &after[end + 2..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

pub fn available_topic_items() -> Vec<PrimerTopicItem> {
    topics()
        .into_iter()
        .map(|t| PrimerTopicItem {
            name: t.name,
            title: t.title,
            description: t.description,
        })
        .collect()
}

pub fn get_primer(raw_topic: Option<&str>) -> Result<PrimerResult, String> {
    let normalized = raw_topic.unwrap_or("").trim().to_lowercase();
    let available = available_topic_items();

    if normalized.is_empty() || normalized == "index" || normalized == "help" {
        let mut lines = vec![
            "# Medha Primer Index".to_string(),
            "".to_string(),
            "Medha is an evidential memory engine. Use this primer for token-frugal agent guidance.".to_string(),
            "".to_string(),
            "### Available Topics".to_string(),
        ];
        for t in &available {
            lines.push(format!(
                "- **`{}`**: {} — *{}*",
                t.name, t.title, t.description
            ));
        }
        lines.push("".to_string());
        lines.push("### Usage".to_string());
        lines.push("- CLI: `medha primer <topic>` (e.g. `medha primer signals`)".to_string());
        lines.push("- CLI JSON: `medha primer <topic> --json`".to_string());
        lines.push("- MCP Tool: `primer(topic: \"guards\")`".to_string());

        let line_count = lines.len();
        let content = lines.join("\n");
        return Ok(PrimerResult {
            topic: "index".to_string(),
            title: "Medha Primer: Available Topics".to_string(),
            description: "Index of available agent primer topics.".to_string(),
            content,
            line_count,
            available_topics: available,
        });
    }

    let all = topics();
    if let Some(def) = all.iter().find(|t| t.name == normalized) {
        let content = fill(&def.template, &primer_values());
        Ok(PrimerResult {
            topic: def.name.clone(),
            title: def.title.clone(),
            description: def.description.clone(),
            line_count: content.lines().count(),
            content,
            available_topics: available,
        })
    } else {
        let valid = all
            .iter()
            .map(|t| format!("'{}'", t.name))
            .collect::<Vec<_>>()
            .join(", ");
        Err(format!(
            "Unknown topic '{}'. Must be one of {}",
            normalized, valid
        ))
    }
}

pub fn render_primer(result: &PrimerResult, compact: bool) -> String {
    if compact {
        format!("{}\n", result.content)
    } else {
        format!(
            "{}\n\n---\n*Medha Primer ({}) | Run 'medha primer' to view all topics.*\n",
            result.content, result.topic
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every placeholder in every topic is one this kernel fills (gh-19: no hand-typed numbers).
    #[test]
    fn every_topic_fills_every_placeholder() {
        for topic in topics() {
            let rendered = get_primer(Some(&topic.name))
                .expect("topic renders")
                .content;
            assert!(
                !rendered.contains("{{"),
                "primer topic '{}' has an unfilled placeholder",
                topic.name
            );
        }
    }

    #[test]
    fn numbers_come_from_the_kernel() {
        let model = get_primer(Some("mental-model")).unwrap().content;
        assert!(model.contains(&format!("T ≥ {ACTIVE_THRESHOLD}")));
        assert!(model.contains(&format!("at least {MIN_USES_FOR_RETIRED} trials")));
        let guards = get_primer(Some("guards")).unwrap().content;
        assert!(guards.contains("No guard: G = 0.5"));
        assert!(guards.contains("Failed: G = 0,"));
    }
}
