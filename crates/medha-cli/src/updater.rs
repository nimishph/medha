use crate::args::{UpdaterAction, UpdaterArgs};
use serde_json::json;
use std::fs;
use std::path::PathBuf;

pub fn run_updater(
    args: &UpdaterArgs,
    home_dir: &PathBuf,
    json_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    match &args.action {
        UpdaterAction::List => {
            let updaters = json!([
                {
                    "name": "ema",
                    "source": "builtin",
                    "description": "Exponential moving average with configurable alpha (default 0.1)"
                },
                {
                    "name": "wilson",
                    "source": "builtin",
                    "description": "Wilson score interval lower bound"
                }
            ]);
            let report = json!({
                "home": home_dir.display().to_string(),
                "updaters": updaters
            });
            if json_mode {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                println!("updaters (2):");
                println!("  ema (builtin)");
                println!("  wilson (builtin)");
            }
        }
        UpdaterAction::Show(show_args) => {
            let name = &show_args.name;
            if name != "ema" && name != "wilson" {
                eprintln!("medha error: no updater named '{}'\nknown updaters: ema, wilson", name);
                std::process::exit(1);
            }
            let report = if name == "ema" {
                json!({
                    "home": home_dir.display().to_string(),
                    "name": "ema",
                    "source": "builtin",
                    "description": "Exponential moving average with configurable alpha (default 0.1)",
                    "alpha": 0.1
                })
            } else {
                json!({
                    "home": home_dir.display().to_string(),
                    "name": "wilson",
                    "source": "builtin",
                    "description": "Wilson score interval lower bound"
                })
            };
            if json_mode {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                println!("updater:     {}", name);
                println!("source:      builtin");
                println!("description: {}", report["description"].as_str().unwrap_or(""));
            }
        }
        UpdaterAction::Fork(fork_args) => {
            let name = &fork_args.name;
            if name != "ema" && name != "wilson" {
                eprintln!("medha error: no updater named '{}'\nknown updaters: ema, wilson", name);
                std::process::exit(1);
            }
            let dest = if let Some(ref out) = fork_args.out {
                PathBuf::from(out)
            } else {
                home_dir.join("updaters").join(format!("{}-fork.ts", name))
            };
            if dest.exists() {
                eprintln!("medha error: file '{}' already exists", dest.display());
                std::process::exit(1);
            }
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)?;
            }
            let template = format!(
                "// Custom weight updater scaffolded from '{}'\n\
                 export default {{\n  name: '{}-fork',\n  update(current: number, signalValue: number): number {{\n    return current + 0.1 * (signalValue - current);\n  }}\n}};\n",
                name, name
            );
            fs::write(&dest, template)?;
            if json_mode {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&json!({
                        "home": home_dir.display().to_string(),
                        "name": name,
                        "path": dest.display().to_string(),
                    }))?
                );
            } else {
                println!("scaffolded custom updater from '{}'", name);
                println!("  file: {}", dest.display());
            }
        }
    }
    Ok(())
}

