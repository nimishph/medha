//! `medha policy` command implementation (medha-534).

use crate::args::PolicyArgs;
use medha::core::policy_latch::{PolicyLatchInput, PolicyLatchOutcome, PolicyLatchRecommendation};
use medha::core::types::EntityKey;
use medha::store::StorePort;
use medha::MedhaEngine;

pub fn run_policy<S: StorePort>(
    args: PolicyArgs,
    engine: &MedhaEngine<S>,
    now: i64,
    global_json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let key = EntityKey::new(&args.namespace, &args.kind, &args.id);

    let parsed_context = if let Some(ref c) = args.context {
        if c.trim().starts_with('{') {
            serde_json::from_str(c)
                .ok()
                .or_else(|| Some(serde_json::Value::String(c.clone())))
        } else {
            Some(serde_json::Value::String(c.clone()))
        }
    } else {
        None
    };

    let input = PolicyLatchInput {
        key,
        context: parsed_context,
        author: args.author,
        action: args.action,
        min_trust: args.min_trust,
    };

    let outcome = engine.policy_latch(&input, now)?;

    if global_json {
        println!("{}", serde_json::to_string_pretty(&outcome)?);
    } else {
        print!("{}", render_policy(&outcome));
    }

    Ok(())
}

pub fn render_policy(outcome: &PolicyLatchOutcome) -> String {
    let mut out = String::new();
    let allow_str = if outcome.allowed {
        "ALLOW"
    } else if outcome.latched {
        "LATCHED (ESCALATE)"
    } else {
        "BLOCK"
    };

    let rec_str = match outcome.recommendation {
        PolicyLatchRecommendation::Proceed => "proceed",
        PolicyLatchRecommendation::EscalateToHuman => "escalate_to_human",
        PolicyLatchRecommendation::Block => "block",
        PolicyLatchRecommendation::Skip => "skip",
    };

    let reason_str = format!("{:?}", outcome.reason).to_lowercase();

    out.push_str(&format!("policy: {} [{}]\n", allow_str, reason_str));
    out.push_str(&format!("  recommendation: {}\n", rec_str));
    out.push_str(&format!("  status:         {:?}\n", outcome.status));
    out.push_str(&format!("  trust:          {:.3}\n", outcome.trust));
    out.push_str(&format!("  requires human: {}\n", outcome.requires_human));
    out.push_str(&format!("  explanation:    {}\n", outcome.explanation));

    if let Some(ref kase) = outcome.matched_case {
        let dec_str = match &kase.kase.decision {
            medha_core::decision::Decision::Apply => "apply",
            medha_core::decision::Decision::Ignore => "ignore",
            medha_core::decision::Decision::Probability { value } => {
                &format!("probability({})", value)
            }
        };
        out.push_str(&format!(
            "  matched branch: {} ({}) -> {}\n",
            kase.kase.id, kase.kase.condition, dec_str
        ));
    }
    if let Some(ref esc) = outcome.escalation_instructions {
        out.push_str(&format!("  escalation:     {}\n", esc));
    }

    out
}
