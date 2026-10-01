mod args;
mod mcp;
mod render;

use args::*;
use clap::Parser;
use medha::config::{BackendKind, MedhaConfig, CONFIG_FILE, MEDHA_HOME_DIR, SQLITE_FILE};
use medha::core::types::EntityKey;
use medha::{GuardInput, MedhaEngine, RecordInput, SweepOptions};
use render::*;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::exit;

fn main() {
    let cli = Cli::parse();
    if let Err(err) = run(cli) {
        eprintln!("medha error: {}", err);
        exit(1);
    }
}

fn resolve_home(explicit_home: Option<&str>) -> Option<PathBuf> {
    if let Some(h) = explicit_home {
        let p = PathBuf::from(h);
        if p.is_dir() {
            return Some(p);
        }
    }
    let cwd = env::current_dir().ok()?;
    MedhaConfig::find_home(&cwd)
}

fn run(cli: Cli) -> Result<(), Box<dyn std::error::Error>> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    // Handle `init` without requiring an existing .medha directory
    if let Commands::Init(init_args) = &cli.command {
        let home_dir = if let Some(ref h) = cli.home {
            PathBuf::from(h)
        } else {
            env::current_dir()?.join(MEDHA_HOME_DIR)
        };

        if home_dir.join(CONFIG_FILE).exists() {
            if cli.json {
                println!(
                    "{}",
                    serde_json::json!({ "status": "exists", "path": home_dir.display().to_string() })
                );
            } else {
                println!("medha: already initialized at {}", home_dir.display());
            }
            return Ok(());
        }

        fs::create_dir_all(&home_dir)?;

        let backend = if init_args.backend == "memory" {
            BackendKind::Memory
        } else {
            BackendKind::Sqlite
        };

        let store_path = if backend == BackendKind::Sqlite {
            Some(
                init_args
                    .path
                    .clone()
                    .unwrap_or_else(|| SQLITE_FILE.to_string()),
            )
        } else {
            None
        };

        let config = MedhaConfig {
            backend: backend.clone(),
            path: store_path.clone(),
            ..Default::default()
        };

        config.save_to_file(home_dir.join(CONFIG_FILE))?;

        if backend == BackendKind::Sqlite {
            let db_rel = store_path.unwrap_or_else(|| SQLITE_FILE.to_string());
            let db_abs = home_dir.join(db_rel);
            let _ = MedhaEngine::open_sqlite(db_abs.to_string_lossy().to_string())?;
        }

        if cli.json {
            println!(
                "{}",
                serde_json::json!({ "status": "created", "path": home_dir.display().to_string() })
            );
        } else {
            println!("medha: initialized engine home at {}", home_dir.display());
        }
        return Ok(());
    }

    // Resolve existing home
    let home_dir = resolve_home(cli.home.as_deref()).ok_or(
        "No .medha directory found. Run `medha init` to initialize evidential memory in this directory.",
    )?;

    let config = MedhaConfig::load_from_file(home_dir.join(CONFIG_FILE))?;

    // Open backend
    let db_path = home_dir.join(config.path.as_deref().unwrap_or(SQLITE_FILE));
    let mut engine = MedhaEngine::open_sqlite(db_path.to_string_lossy().to_string())?;

    match cli.command {
        Commands::Init(_) => unreachable!(),
        Commands::Propose(args) => {
            let key = EntityKey::new(&args.namespace, &args.kind, &args.id);
            let res = engine.propose(&key, &args.source, args.theta0, args.description, now)?;
            let hint = engine.hint(&key, now)?;

            if cli.json {
                println!(
                    "{}",
                    serde_json::json!({
                        "episode": res.episode,
                        "hint": hint,
                    })
                );
            } else {
                println!(
                    "medha: proposed {} (source: {})\n  trust:    {:.3}  status: {:?}",
                    key.to_string_repr(),
                    args.source,
                    hint.trust,
                    hint.status
                );
            }
        }
        Commands::Record(args) => {
            let key = EntityKey::new(&args.namespace, &args.kind, &args.id);
            let res = engine.record(RecordInput {
                key: key.clone(),
                signal: args.signal.clone(),
                at: now,
                author: args.author,
                anchors: None,
                run_ref: args.run_ref,
                note: args.note,
                case_id: None,
            })?;
            let hint = engine.hint(&key, now)?;

            if cli.json {
                println!(
                    "{}",
                    serde_json::json!({
                        "episode": res.episode,
                        "hint": hint,
                    })
                );
            } else {
                println!(
                    "medha: recorded {} on {}\n  trust:    {:.3}  status: {:?}",
                    args.signal,
                    key.to_string_repr(),
                    hint.trust,
                    hint.status
                );
            }
        }
        Commands::Guard(args) => {
            let key = EntityKey::new(&args.namespace, &args.kind, &args.id);
            let ok = if args.fail { false } else { args.ok };
            let res = engine.guard(GuardInput {
                key: key.clone(),
                ok,
                kind: args.guard_kind.clone(),
                at: now,
                author: args.author,
                note: args.note,
            })?;
            let hint = engine.hint(&key, now)?;

            if cli.json {
                println!(
                    "{}",
                    serde_json::json!({
                        "episode": res.episode,
                        "hint": hint,
                    })
                );
            } else {
                println!(
                    "medha: guard {} on {}\n  trust:    {:.3}  status: {:?}",
                    if ok { "passed" } else { "failed" },
                    key.to_string_repr(),
                    hint.trust,
                    hint.status
                );
            }
        }
        Commands::Show(args) => {
            let key = EntityKey::new(&args.namespace, &args.kind, &args.id);
            let report = engine.show(&key, now)?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                print!("{}", render_show(&report));
            }
        }
        Commands::ExplainThreshold(args) => {
            let key = EntityKey::new(&args.namespace, &args.kind, &args.id);
            let report = engine.explain_threshold(&key, now)?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                print!("{}", render_explain_threshold(&report));
            }
        }
        Commands::Hints(args) => {
            let all = engine.list()?;
            let mut keys = Vec::new();
            for ent in all {
                if let Some(ref k) = args.kind {
                    if &ent.key.kind != k {
                        continue;
                    }
                }
                if let Some(ref ns) = args.namespace {
                    if &ent.key.namespace != ns {
                        continue;
                    }
                }
                keys.push(ent.key);
            }

            let hints = engine.hints(&keys, now)?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&hints)?);
            } else {
                for h in &hints {
                    println!("{}", render_hint(h));
                }
            }
        }
        Commands::Simulate(args) => {
            let key = EntityKey::new(&args.namespace, &args.kind, &args.id);
            let sim = engine.simulate(&key, &args.signal, now)?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&sim)?);
            } else {
                print!("{}", render_simulation(&sim));
            }
        }
        Commands::Sweep(args) => {
            let sweep_report = engine.sweep(
                SweepOptions {
                    prune_retired: args.prune,
                    max_age_days: args.older_than,
                },
                now,
            )?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&sweep_report)?);
            } else {
                println!("medha: swept {} entities", sweep_report.swept_count);
                for ch in &sweep_report.changes {
                    println!("  {} -> {:?} ({})", ch.key, ch.new_status, ch.reason);
                }
            }
        }
        Commands::Override(args) => {
            let key = EntityKey::new(&args.namespace, &args.kind, &args.id);
            let res = engine.override_status(&key, args.status.into(), &args.reason, now)?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&res)?);
            } else {
                println!(
                    "medha: overridden {} to {:?}",
                    key.to_string_repr(),
                    args.status
                );
            }
        }
        Commands::Sync(args) => match args.action {
            SyncAction::Status => {
                let sync_report = engine.sync_status()?;
                if cli.json {
                    println!("{}", serde_json::to_string_pretty(&sync_report)?);
                } else {
                    println!("medha: sync status: {:?}", sync_report.state);
                    println!("  local count:  {}", sync_report.local_count);
                    if let Some(rc) = sync_report.remote_count {
                        println!("  remote count: {}", rc);
                    }
                }
            }
            SyncAction::Pull => {
                let res = engine.sync_pull()?;
                if cli.json {
                    println!("{}", serde_json::to_string_pretty(&res)?);
                } else {
                    println!(
                        "medha: sync pull complete (updated: {}, pulled: {}, local total: {})",
                        res.updated, res.pulled_count, res.local_total
                    );
                }
            }
            SyncAction::Push => {
                let res = engine.sync_push(Some(now))?;
                if cli.json {
                    println!("{}", serde_json::to_string_pretty(&res)?);
                } else {
                    println!(
                        "medha: sync push complete (pushed: {}, commit: {:?})",
                        res.pushed_count, res.commit
                    );
                }
            }
            SyncAction::Reconcile => {
                let res = engine.sync_reconcile(Some(now))?;
                if cli.json {
                    println!("{}", serde_json::to_string_pretty(&res)?);
                } else {
                    println!(
                        "medha: sync reconcile complete (pulled: {}, pushed: {}, total: {})",
                        res.pulled_count, res.pushed_count, res.total_count
                    );
                }
            }
        },
        Commands::Compact(_) => {
            let comp = engine.compact(now)?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&comp)?);
            } else {
                println!(
                    "medha: compaction complete: before={}, after={}, removed={}",
                    comp.before_count, comp.after_count, comp.removed_count
                );
            }
        }
        Commands::Preflight(_) => {
            let pre = engine.preflight()?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&pre)?);
            } else {
                println!(
                    "medha: preflight integrity: {}",
                    if pre.ok { "OK" } else { "FAILED" }
                );
                println!("  entities: {}", pre.total_entities);
                println!("  episodes: {}", pre.total_episodes);
                for issue in &pre.issues {
                    println!("  issue:    {}", issue);
                }
            }
        }
        Commands::List(args) => {
            let all_states = engine.list()?;
            let mut hints = Vec::new();
            for s in all_states {
                if let Some(ref k) = args.kind {
                    if &s.key.kind != k {
                        continue;
                    }
                }
                if let Some(ref ns) = args.namespace {
                    if &s.key.namespace != ns {
                        continue;
                    }
                }
                let h = engine.hint(&s.key, now)?;
                if let Some(ref st) = args.status {
                    let st_lower = format!("{:?}", h.status).to_lowercase();
                    if &st_lower != st {
                        continue;
                    }
                }
                hints.push(h);
            }
            if let Some(lim) = args.limit {
                hints.truncate(lim);
            }
            if cli.json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "home": home_dir.display().to_string(),
                        "asOf": now,
                        "page": {
                            "items": hints,
                            "total": hints.len(),
                            "hasMore": false
                        }
                    }))?
                );
            } else {
                println!("medha: {} entities", hints.len());
                println!("  TRUST  STATUS     DRIFT  KEY");
                for h in &hints {
                    println!(
                        "  {:.3}  {:9}  {:5}  {}",
                        h.trust,
                        format!("{:?}", h.status).to_lowercase(),
                        if h.is_drifting { "yes" } else { "no" },
                        h.key.to_string_repr()
                    );
                }
            }
        }
        Commands::Status(_) => {
            let pre = engine.preflight()?;
            let all_states = engine.list()?;
            let mut by_status = std::collections::HashMap::new();
            let mut drifting = 0;
            for s in &all_states {
                let h = engine.hint(&s.key, now)?;
                let st_name = format!("{:?}", h.status).to_lowercase();
                *by_status.entry(st_name).or_insert(0) += 1;
                if h.is_drifting {
                    drifting += 1;
                }
            }
            if cli.json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "home": home_dir.display().to_string(),
                        "asOf": now,
                        "preflight": {
                            "status": if pre.ok { "ok" } else { "failed" },
                            "episodeCount": pre.total_episodes,
                            "entityCount": pre.total_entities,
                            "integrity": if pre.ok { "ok" } else { "failed" },
                        },
                        "byStatus": by_status,
                        "drifting": drifting,
                    }))?
                );
            } else {
                println!("medha: status for {}", home_dir.display());
                println!(
                    "  preflight:  ok — {} episodes, {} entities, integrity ok",
                    pre.total_episodes, pre.total_entities
                );
                println!(
                    "  by status:  probation {}, active {}, trusted {}, quarantined {}, retired {}",
                    by_status.get("probation").unwrap_or(&0),
                    by_status.get("active").unwrap_or(&0),
                    by_status.get("trusted").unwrap_or(&0),
                    by_status.get("quarantined").unwrap_or(&0),
                    by_status.get("retired").unwrap_or(&0),
                );
                println!("  drifting:   {}", drifting);
            }
        }
        Commands::Drift(args) => {
            let all_states = engine.list()?;
            let mut drifting_hints = Vec::new();
            for s in all_states {
                let h = engine.hint(&s.key, now)?;
                if h.is_drifting {
                    drifting_hints.push(h);
                }
            }
            if let Some(lim) = args.limit {
                drifting_hints.truncate(lim);
            }
            if cli.json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "home": home_dir.display().to_string(),
                        "count": drifting_hints.len(),
                        "entities": drifting_hints,
                    }))?
                );
            } else {
                println!(
                    "medha: {} entities currently drifting",
                    drifting_hints.len()
                );
                for h in &drifting_hints {
                    println!(
                        "  {} (drift: {:.3})",
                        h.key.to_string_repr(),
                        h.breakdown.wilson_lower
                    );
                }
            }
        }
        Commands::Mcp(_) => {
            mcp::run_mcp_server(engine)?;
        }
    }

    Ok(())
}
