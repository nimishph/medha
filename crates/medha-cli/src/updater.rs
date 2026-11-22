//! `medha updater list|show|fork` in the TypeScript CLI's shapes (`cli/src/updater.ts`).
//!
//! The catalog lists the TypeScript built-ins. This engine applies `ema` itself; the others are
//! weight updaters of the TypeScript engine, and custom (project) updaters are TypeScript modules
//! loaded by the TypeScript CLI (ADR-0001, medha-dvv.5). `fork` scaffolds such a module.

use crate::args::{UpdaterAction, UpdaterArgs};
use crate::failure::Failure;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};

/// The TypeScript `BUILTIN_UPDATERS`, in registry order.
pub const BUILTIN_UPDATERS: [&str; 4] = ["ema", "wilson", "sliding-window", "asymmetric-penalty"];

fn description(name: &str) -> String {
    match name.to_lowercase().as_str() {
        "ema" => "Exponential Moving Average with canonical trial weighting".to_string(),
        "wilson" => {
            "Wilson score interval lower bound (confidence-adjusted success rate)".to_string()
        }
        "sliding-window" => "Sliding-window trial history (fixed recent trial memory)".to_string(),
        "asymmetric-penalty" | "asymmetric" => {
            "Asymmetric penalty (moderate gain on success, harsh penalty on rejection)".to_string()
        }
        other => format!("Custom builtin weight updater '{other}'"),
    }
}

fn find(name: &str) -> Result<&'static str, Failure> {
    BUILTIN_UPDATERS
        .iter()
        .find(|u| u.eq_ignore_ascii_case(name))
        .copied()
        .ok_or_else(|| {
            Failure::cli(
                "UpdaterNotFoundError",
                "CLI_UPDATER_UNKNOWN",
                format!("no updater named '{name}'"),
            )
            .with_context(json!({ "name": name, "known": BUILTIN_UPDATERS }))
            .with_hint(format!("known updaters: {}", BUILTIN_UPDATERS.join(", ")))
        })
}

/// `/[-_]([a-z])/g` → uppercase letter, as the TypeScript `toCamelCase`.
fn to_camel_case(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match chars.get(i + 1) {
            Some(n) if (c == '-' || c == '_') && n.is_ascii_lowercase() => {
                out.push(n.to_ascii_uppercase());
                i += 2;
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

/// The TypeScript `generateUpdaterTemplate`, byte for byte.
fn template(base: &str, file_name: &str) -> String {
    let updater_name = match file_name.rfind('.') {
        Some(i) => &file_name[..i],
        None => file_name,
    };
    let var_name = format!("{}CustomUpdater", to_camel_case(base));
    let logic = match base.to_lowercase().as_str() {
        "ema" => "    // Exponential moving average:
    const alpha = ctx.parameters && typeof (ctx.parameters as any).alpha === 'number' ? (ctx.parameters as any).alpha : 0.1;
    const signalVal = ctx.signal.countsAsSuccess ? 1 : ctx.signal.countsAsTrial ? -1 : 0;
    const newWeight = Math.max(0, Math.min(1, ctx.currentWeight + alpha * (signalVal - ctx.currentWeight)));
    const isDrifting = Math.abs(newWeight - ctx.initialWeight) > 0.3;
    return { newWeight, isDrifting };",
        "asymmetric-penalty" | "asymmetric" => "    // Asymmetric penalty: moderate gain on success (+0.04), harsh penalty on rejection (-0.25)
    const delta =
      ctx.signal.countsAsTrial && ctx.signal.countsAsSuccess
        ? 0.04 * (1 - ctx.currentWeight)
        : ctx.signal.name === 'REJECT_CONTEXT'
          ? -0.05 * ctx.currentWeight
          : ctx.signal.countsAsTrial
            ? -0.25 * ctx.currentWeight
            : 0;
    const newWeight = Math.max(0, Math.min(1, ctx.currentWeight + delta));
    const isDrifting = ctx.sampleCount >= 10 && Math.abs(newWeight - ctx.initialWeight) > 0.3;
    return { newWeight, isDrifting };",
        "sliding-window" => "    // Sliding window bounded step:
    const step = 1 / Math.max(10, Math.min(50, ctx.sampleCount + 1));
    const delta =
      ctx.signal.countsAsTrial && ctx.signal.countsAsSuccess
        ? step * (1 - ctx.currentWeight)
        : ctx.signal.name === 'REJECT_CONTEXT'
          ? -step * 0.5 * ctx.currentWeight
          : ctx.signal.countsAsTrial
            ? -step * ctx.currentWeight
            : 0;
    const newWeight = Math.max(0, Math.min(1, ctx.currentWeight + delta));
    const isDrifting = ctx.sampleCount >= 10 && Math.abs(newWeight - ctx.initialWeight) > 0.3;
    return { newWeight, isDrifting };",
        _ => "    // Wilson-inspired / custom confidence logic:
    const countsAsSuccess = ctx.signal.countsAsTrial && ctx.signal.countsAsSuccess;
    const totalPositive = ctx.acceptanceCount + (countsAsSuccess ? 1 : 0);
    const totalSamples = ctx.sampleCount + 1;
    const ratio = totalPositive / totalSamples;
    const newWeight = Math.max(0, Math.min(1, 0.5 * ctx.initialWeight + 0.5 * ratio));
    const isDrifting = totalSamples >= 10 && Math.abs(newWeight - ctx.initialWeight) > 0.3;
    return { newWeight, isDrifting };",
    };
    format!(
        "import type {{ MedhaWeightUpdater, WeightUpdateContext, WeightUpdateOutcome }} from '@cntxt-labs/medha';

/**
 * Custom weight updater scaffolded from '{base}'.
 *
 * AUTOMATIC DISCOVERY:
 * When located in '<home>/updaters/{file_name}', the Medha CLI, MCP server,
 * and UI automatically discover and register this updater under the name '{updater_name}'.
 *
 * PROGRAMMATIC Usage:
 *
 *   import {{ Medha, UpdaterRegistry }} from '@cntxt-labs/medha';
 *   import {{ {var_name} }} from './{file_name}';
 *
 *   const updaters = new UpdaterRegistry({{
 *     project: {{ '{updater_name}': {var_name} }},
 *   }});
 *   const medha = new Medha({{ store, updaters }});
 */
export const {var_name}: MedhaWeightUpdater = {{
  name: '{updater_name}',
  computeWeight(ctx: WeightUpdateContext): WeightUpdateOutcome {{
{logic}
  }},
}};
"
    )
}

pub fn run_updater(
    args: &UpdaterArgs,
    home_dir: &Path,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let home = home_dir.display().to_string();
    match &args.action {
        UpdaterAction::List => {
            let updaters: Vec<_> = BUILTIN_UPDATERS
                .iter()
                .map(|n| json!({ "name": n, "source": "builtin" }))
                .collect();
            if json_mode {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&json!({ "home": home, "updaters": updaters }))?
                );
            } else {
                println!("updaters ({}):", BUILTIN_UPDATERS.len());
                for n in BUILTIN_UPDATERS {
                    println!("  {n:<22} [builtin]");
                }
            }
        }
        UpdaterAction::Show(show_args) => {
            let name = find(&show_args.name)?;
            let report = json!({
                "home": home,
                "name": name,
                "source": "builtin",
                "description": description(name),
            });
            if json_mode {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                println!("updater:     {name}");
                println!("source:      builtin");
                println!("description: {}", description(name));
            }
        }
        UpdaterAction::Fork(fork_args) => {
            let name = find(&fork_args.name)?;
            let dest = match &fork_args.out {
                Some(out) => std::path::absolute(PathBuf::from(out))?,
                None => home_dir.join("updaters").join(format!("{name}-fork.ts")),
            };
            if dest.exists() {
                return Err(Box::new(
                    Failure::cli(
                        "UpdaterForkError",
                        "CLI_FORK_EXISTS",
                        format!("{} already exists", dest.display()),
                    )
                    .with_context(json!({ "path": dest.display().to_string() }))
                    .with_hint("remove it first, or pass --out to a fresh path"),
                ));
            }
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)?;
            }
            let file_name = dest
                .file_name()
                .map(|f| f.to_string_lossy().to_string())
                .unwrap_or_default();
            fs::write(&dest, template(name, &file_name))?;
            let path = dest.display().to_string();
            if json_mode {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&json!({
                        "home": home,
                        "name": name,
                        "path": path,
                        "scaffolded": true,
                    }))?
                );
            } else {
                println!("scaffolded custom updater from '{name}'");
                println!("  path: {path}");
                println!("  load: import and pass via MedhaOptions {{ updaters: new UpdaterRegistry({{ project: {{ ... }} }}) }}");
            }
        }
    }
    Ok(())
}
