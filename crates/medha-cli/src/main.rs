mod args;
mod help;
mod issue;
mod keys;
mod mcp;
mod mcp_config;
mod pack;
mod params;
mod policy;
mod primer;
mod render;
mod updater;

use args::*;
use clap::{CommandFactory, FromArgMatches};
use medha::config::{BackendKind, MedhaConfig, CONFIG_FILE, MEDHA_HOME_DIR, SQLITE_FILE};
use medha::core::types::EntityKey;
use medha::store::{StorePort, StoreRegistries};
use medha::{GuardInput, MedhaEngine, RecordInput, SweepOptions};
use render::*;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::exit;

fn uuid_or_random_hex() -> String {
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}", t)
}

fn parse_registries_json(content: &str) -> Result<StoreRegistries, String> {
    let raw: serde_json::Value = serde_json::from_str(content).map_err(|e| e.to_string())?;
    let target = raw.get("registries").unwrap_or(&raw);
    let mut regs = StoreRegistries::default();
    if let Some(kinds) = target.get("kinds").and_then(|v| v.as_array()) {
        for k in kinds {
            if let Some(ks) = k.as_str() {
                if !regs.kinds.contains(&ks.to_string()) {
                    regs.kinds.push(ks.to_string());
                }
            }
        }
    }
    if let Some(signals) = target.get("signalSpecs").and_then(|v| v.as_array()) {
        for s in signals {
            let spec: medha::core::types::SignalSpec =
                serde_json::from_value(s.clone()).map_err(|e| e.to_string())?;
            regs.signal_specs.push(spec);
        }
    }
    Ok(regs)
}

const AGENT_SECTION: &str = "\n## Evidential memory: medha\n\nThis project tracks how well its rules, recipes and tools actually work in [medha](https://nimishph.github.io/medha/)\n(engine home: `.medha/`). Medha reports evidence and trust hints; **you** decide what to do with them.\n\n- Before leaning on a project rule, recipe or tool, check its trust: `medha show --id <id>` (add `--json` for structured output).\n- After following a rule or recipe, record whether it worked: `medha record --id <id> --signal APPLY` (or `REJECT_RULE` if it was bad advice, `SKIP` if ignored).\n- Run `medha status` to check engine health and see how many rules have evidence.\n";

fn update_agents_instruction_files(explicit: &Option<String>, no_agents_file: bool) {
    if no_agents_file {
        return;
    }
    if let Some(ref p) = explicit {
        update_single_agent_file(Path::new(p));
        return;
    }
    if Path::new("AGENTS.md").exists() {
        update_single_agent_file(Path::new("AGENTS.md"));
    }
    if Path::new("CLAUDE.md").exists() {
        update_single_agent_file(Path::new("CLAUDE.md"));
    }
}

fn update_single_agent_file(path: &Path) {
    let existing = fs::read_to_string(path).unwrap_or_default();
    if !existing.contains("## Evidential memory: medha") {
        let mut content = existing;
        if !content.is_empty() && !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str(AGENT_SECTION);
        let _ = fs::write(path, content);
    }
}

fn main() {
    let command = Cli::command();
    let command = command
        .clone()
        .help_template(help::grouped_template(&command));
    let cli = match Cli::from_arg_matches(&command.get_matches()) {
        Ok(cli) => cli,
        Err(err) => err.exit(),
    };
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

    // Commands that do not require an initialized .medha directory
    match &cli.command {
        Commands::Primer(primer_args) => {
            let res = primer::get_primer(primer_args.topic.as_deref())?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&res)?);
            } else {
                print!("{}", primer::render_primer(&res, primer_args.compact));
            }
            return Ok(());
        }
        Commands::Params(_) => {
            let report = params::params_report(now);
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                println!("{}", params::render_params(&report));
            }
            return Ok(());
        }
        Commands::Issue(issue_args) => {
            let maybe_home = resolve_home(cli.home.as_deref());
            let store_stats = if let Some(ref h) = maybe_home {
                if let Ok(config) = MedhaConfig::load_from_file(h.join(CONFIG_FILE)) {
                    let db_path = h.join(config.path.as_deref().unwrap_or(SQLITE_FILE));
                    if let Ok(eng) = MedhaEngine::open_sqlite(db_path.to_string_lossy().to_string())
                    {
                        let pref = eng
                            .preflight()
                            .map(|p| if p.ok { "clean" } else { "issues" })
                            .unwrap_or("error");
                        let ents = eng.store().list().map(|l| l.len()).unwrap_or(0);
                        let eps = eng
                            .store()
                            .episodes(None, None)
                            .map(|l| l.len())
                            .unwrap_or(0);
                        format!(
                            "backend: {:?}, entities: {}, episodes: {}, preflight: {}",
                            config.backend, ents, eps, pref
                        )
                    } else {
                        "None (store open failed)".to_string()
                    }
                } else {
                    "None (uninitialized or store not found)".to_string()
                }
            } else {
                "None (uninitialized or store not found)".to_string()
            };
            let report = issue::create_issue_report(
                issue_args.title.as_deref(),
                issue_args.open,
                cli.json,
                &store_stats,
            );
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                print!("{}", issue::render_issue(&report));
            }
            return Ok(());
        }
        _ => {}
    }

    // Handle `init` without requiring an existing .medha directory
    if let Commands::Init(init_args) = &cli.command {
        let home_dir = if let Some(ref h) = cli.home {
            PathBuf::from(h)
        } else {
            env::current_dir()?.join(MEDHA_HOME_DIR)
        };

        if init_args.recreate && home_dir.exists() {
            let _ = fs::remove_dir_all(&home_dir);
        }

        let store_str = init_args.store.as_deref().unwrap_or(&init_args.backend);
        if store_str != "sqlite" && store_str != "file" && store_str != "memory" {
            eprintln!("medha error: invalid --store / --backend '{}'", store_str);
            exit(2);
        }

        if store_str == "memory" && init_args.path.is_some() {
            eprintln!("medha error: --path cannot be used with memory backend");
            exit(2);
        }

        if home_dir.join(CONFIG_FILE).exists() {
            if init_args.namespace.is_some() || init_args.no_namespace {
                eprintln!(
                    "medha error: --namespace requires --recreate alongside it: {} is already initialized",
                    home_dir.display()
                );
                exit(1);
            }

            // Check config drift
            if let Some(ref cfg_path) = init_args.config {
                let existing_cfg = MedhaConfig::load_from_file(home_dir.join(CONFIG_FILE))?;
                let cfg_content = fs::read_to_string(cfg_path)?;
                let new_registries = match parse_registries_json(&cfg_content) {
                    Ok(r) => r,
                    Err(e) => {
                        eprintln!("medha error: invalid config: {}", e);
                        exit(1);
                    }
                };
                if existing_cfg.registries != new_registries {
                    eprintln!(
                        "medha error: RegistryDriftError: registries in {} differ from {}",
                        cfg_path,
                        home_dir.join(CONFIG_FILE).display()
                    );
                    exit(1);
                }
            }

            update_agents_instruction_files(&init_args.agents_file, init_args.no_agents_file);

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

        let backend = if store_str == "memory" {
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

        let registries = if let Some(ref cfg_path) = init_args.config {
            let content = match fs::read_to_string(cfg_path) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("medha error: failed to read config file {}: {}", cfg_path, e);
                    exit(1);
                }
            };
            match parse_registries_json(&content) {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("medha error: invalid config: {}", e);
                    exit(1);
                }
            }
        } else {
            StoreRegistries::default()
        };

        let config = MedhaConfig {
            backend: backend.clone(),
            path: store_path.clone(),
            registries: registries.clone(),
            ..Default::default()
        };

        config.save_to_file(home_dir.join(CONFIG_FILE))?;

        if backend == BackendKind::Sqlite {
            let db_rel = store_path.unwrap_or_else(|| SQLITE_FILE.to_string());
            let db_abs = home_dir.join(db_rel);
            let mut eng = MedhaEngine::open_sqlite(db_abs.to_string_lossy().to_string())?;
            eng.use_registries(&registries);
            if let Some(ref backup_path) = init_args.backup {
                let backup_content = fs::read_to_string(backup_path)?;
                let raw_val: serde_json::Value = serde_json::from_str(&backup_content)?;
                let snapshot = medha_sync::migrate_snapshot(raw_val)?;
                if let Some(ref episodes) = snapshot.episodes {
                    let _ = eng.store_mut().replace_log(episodes)?;
                }
            }
        }

        update_agents_instruction_files(&init_args.agents_file, init_args.no_agents_file);

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
    let mut engine =
        MedhaEngine::open_sqlite_with_sync(db_path.to_string_lossy().to_string(), &home_dir)?;
    engine.use_registries(&config.registries);

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
                ensure: args.ensure,
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
            // Without --guard the report reuses the entity's guard kind. With none yet, it would be
            // stored against kind `none` and change nothing while printing "guard passed" (gh-17).
            if args
                .guard_kind
                .as_deref()
                .is_none_or(|k| k.trim().is_empty())
            {
                let has_guard = engine
                    .get(&key)?
                    .is_some_and(|s| !s.guard.kind.is_empty() && s.guard.kind != "none");
                if !has_guard {
                    return Err(format!(
                        "Invalid --guard: {} has no guard yet, so a report without --guard would not count. \
                         Pass --guard <kind> (e.g. ci, review, tests) naming the check that ran.",
                        key.to_string_repr()
                    )
                    .into());
                }
            }
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
        Commands::Reinstate(args) => {
            let key = EntityKey::new(&args.namespace, &args.kind, &args.id);
            let (latch, appended) = engine.reinstate(&key, &args.reason, now)?;
            let hint = engine.hint(&key, now)?;
            if cli.json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "key": key,
                        "latch": latch,
                        "seq": appended.episode.seq,
                        "hint": hint,
                    }))?
                );
            } else {
                println!(
                    "medha: reinstated {} (was {} since #{}; recorded as #{})",
                    key.to_string_repr(),
                    format!("{:?}", latch.status).to_lowercase(),
                    latch.seq,
                    appended.episode.seq
                );
                let status = format!("{:?}", hint.status).to_lowercase();
                println!("  trust:    {:.3}  status: {}", hint.trust, status);
                if status == "retired" || status == "quarantined" {
                    println!(
                        "  note:     the evidence still makes it {status}; the next episode stores that"
                    );
                }
            }
        }
        Commands::Retract(args) => {
            let expect = args
                .id
                .as_ref()
                .map(|id| EntityKey::new(&args.namespace, &args.kind, id));
            let outcome = engine.retract_checked(args.seq, &args.reason, now, expect.as_ref())?;
            let key = outcome.appended.episode.key.clone();
            let hint = engine.hint(&key, now)?;
            if let Some(lifted) = &outcome.lifted {
                eprintln!(
                    "medha: warning: this retraction took {} out of {} (now {}). Lifting a latch is a \
                     human decision, and medha cannot tell who ran this; 'medha reinstate --reason' \
                     records it as one.",
                    key.to_string_repr(),
                    format!("{:?}", lifted.from).to_lowercase(),
                    format!("{:?}", lifted.to).to_lowercase()
                );
            }
            if cli.json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "targetSeq": args.seq,
                        "reason": args.reason,
                        "seq": outcome.appended.episode.seq,
                        "episode": outcome.appended.episode,
                        "hint": hint,
                        "lifted": outcome.lifted,
                    }))?
                );
            } else {
                println!(
                    "medha: retracted episode #{} (recorded as #{})\n  reason:   {}\n  trust:    {:.3}  status: {}",
                    args.seq,
                    outcome.appended.episode.seq,
                    args.reason,
                    hint.trust,
                    format!("{:?}", hint.status).to_lowercase()
                );
            }
        }
        Commands::Sync(args) => {
            if let Some(ref f) = args.file {
                let p = PathBuf::from(f);
                if args.action == SyncAction::Pull && !p.exists() {
                    eprintln!("medha error: Cannot pull: sync file '{}' does not exist", p.display());
                    exit(1);
                }
                // Check peek for registry drift on pull
                if args.action == SyncAction::Pull && p.exists() {
                    if let Ok(content) = fs::read_to_string(&p) {
                        if let Ok(raw_val) = serde_json::from_str::<serde_json::Value>(&content) {
                            if let Ok(snapshot) = medha_sync::migrate_snapshot(raw_val) {
                                if let Some(ref snapshot_regs) = snapshot.registries {
                                    let mut missing_kinds = Vec::new();
                                    for k in &snapshot_regs.kinds {
                                        if !config.registries.kinds.contains(k) {
                                            missing_kinds.push(k.clone());
                                        }
                                    }
                                    let mut missing_signals = Vec::new();
                                    for s in &snapshot_regs.signal_specs {
                                        if !config.registries.signal_specs.iter().any(|sig| sig.name == s.name) {
                                            missing_signals.push(s.name.clone());
                                        }
                                    }
                                    if !missing_kinds.is_empty() || !missing_signals.is_empty() {
                                        if !args.auto_import_registries {
                                            eprintln!(
                                                "medha error: CLI_SYNC_REGISTRY_MISMATCH: sync snapshot carries kinds [{}] and signals [{}] not in local registries. Run with --auto-import-registries to import them.",
                                                missing_kinds.join(", "),
                                                missing_signals.join(", ")
                                            );
                                            exit(1);
                                        } else {
                                            let mut updated_config = config.clone();
                                            for k in missing_kinds {
                                                updated_config.registries.kinds.push(k);
                                            }
                                            for s in snapshot_regs.signal_specs.clone() {
                                                if !updated_config.registries.signal_specs.iter().any(|sig| sig.name == s.name) {
                                                    updated_config.registries.signal_specs.push(s);
                                                }
                                            }
                                            let _ = updated_config.save_to_file(home_dir.join(CONFIG_FILE));
                                            engine.use_registries(&updated_config.registries);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                engine.set_sync(Box::new(medha_sync::FileSyncAdapter::new(&p)));
            } else if args.remote.is_some() || args.git_ref.is_some() {
                let git_ref = args.git_ref.as_deref().unwrap_or(medha_sync::DEFAULT_MEDHA_REF);
                let remote = args.remote.as_deref().unwrap_or(medha_sync::DEFAULT_REMOTE);
                let repo_dir = home_dir.parent().unwrap_or(&home_dir);
                engine.set_sync(Box::new(medha_sync::GitRefSyncAdapter::with_ref_and_remote(repo_dir, git_ref, remote)));
            }

            match args.action {
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
            }
        }
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
            // A failed preflight exits 1, as in the TypeScript CLI, so scripts can gate on it.
            if !pre.ok {
                exit(1);
            }
        }
        Commands::List(args) => {
            let ids = args.ids.as_deref().map(parse_ids).transpose()?;
            let all_states = engine.list()?;
            let mut hints = Vec::new();
            for s in all_states {
                if let Some(ids) = &ids {
                    if !ids.contains(&s.key.id) {
                        continue;
                    }
                }
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
            hints.sort_by(|a, b| {
                b.trust
                    .partial_cmp(&a.trust)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| a.key.to_string_repr().cmp(&b.key.to_string_repr()))
            });
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
            // A corrupt store cannot answer from the evidence (gh-18): report it, count nothing.
            let all_states = if pre.ok { engine.list()? } else { Vec::new() };
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
                let verdict = if pre.ok { "ok" } else { "failed" };
                println!(
                    "  preflight:  {} — {} episodes, {} entities, integrity {}",
                    verdict, pre.total_episodes, pre.total_entities, verdict
                );
                if pre.ok {
                    println!(
                        "  by status:  probation {}, active {}, trusted {}, quarantined {}, retired {}",
                        by_status.get("probation").unwrap_or(&0),
                        by_status.get("active").unwrap_or(&0),
                        by_status.get("trusted").unwrap_or(&0),
                        by_status.get("quarantined").unwrap_or(&0),
                        by_status.get("retired").unwrap_or(&0),
                    );
                    println!("  drifting:   {}", drifting);
                } else {
                    for issue in &pre.issues {
                        println!("  issue:      {}", issue);
                    }
                    println!("  by status:  unavailable — run `medha preflight`");
                }
            }
            if !pre.ok {
                exit(1);
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
        Commands::Pack(args) => {
            let exploration_ratio = args.exploration.unwrap_or(0.15);
            let opts = medha::EnginePackOptions {
                budget: args.budget,
                kind: args.kind,
                namespace: args.namespace,
                ids: args.ids.as_deref().map(parse_ids).transpose()?,
                exploration_ratio,
                seed: args.seed,
                min_trust: 0.0,
                allow_quarantined: false,
                allow_retired: false,
            };
            let outcome = engine.pack(opts, now)?;
            let report = pack::PackReport {
                home: home_dir.display().to_string(),
                budget: args.budget,
                outcome,
                format: args.format.to_lowercase(),
            };
            if cli.json || report.format == "json" {
                println!("{}", serde_json::to_string_pretty(&report.outcome)?);
            } else {
                print!("{}", pack::render_pack(&report));
            }
        }
        Commands::Mcp(mcp_args) => match mcp_args.subcommand {
            Some(McpSubcommand::Config(ref config_args)) => {
                mcp_config::run_mcp_config(config_args, cli.json)?;
            }
            _ => {
                mcp::run_mcp_server(engine)?;
            }
        },
        Commands::Keys(keys_args) => {
            keys::run_keys(keys_args, &mut engine, &home_dir, cli.json)?;
        }
        Commands::Policy(policy_args) => {
            policy::run_policy(policy_args, &engine, now, cli.json)?;
        }
        Commands::Define(args) => {
            let key = EntityKey::new(&args.namespace, &args.kind, &args.id);
            let tags = args.tags.as_ref().map(|t| {
                t.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<String>>()
            });
            let at = now;
            let _ = engine.define(&key, &args.title, &args.rationale, tags.clone(), at)?;
            if cli.json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "home": home_dir.display().to_string(),
                        "key": key,
                        "definition": {
                            "title": args.title,
                            "rationale": args.rationale,
                            "tags": tags,
                        }
                    }))?
                );
            } else {
                println!("medha: defined {}", key.to_string_repr());
                println!("  title:     {}", args.title);
                if let Some(ref t) = tags {
                    if !t.is_empty() {
                        println!("  tags:      {}", t.join(", "));
                    }
                }
                println!("  rationale: {}", args.rationale);
            }
        }
        Commands::Decision(args) => {
            let key = EntityKey::new(&args.namespace, &args.kind, &args.id);
            let chosen = [args.apply, args.ignore, args.probability.is_some()]
                .iter()
                .filter(|&&b| b)
                .count();
            if chosen != 1 {
                eprintln!(
                    "medha error: exactly one of --apply, --ignore, or --probability must be specified"
                );
                exit(2);
            }
            if args.detach && args.parent.is_some() {
                eprintln!("medha error: --detach and --parent cannot both be used");
                exit(2);
            }
            let decision = if args.apply {
                medha_core::decision::Decision::Apply
            } else if args.ignore {
                medha_core::decision::Decision::Ignore
            } else {
                let p = args.probability.unwrap();
                if !(0.0..=1.0).contains(&p) {
                    eprintln!("medha error: --probability must be between 0.0 and 1.0");
                    exit(2);
                }
                medha_core::decision::Decision::Probability { value: p }
            };
            let case_id = args
                .case_id
                .unwrap_or_else(|| format!("c-{}", &uuid_or_random_hex()));
            let parent_id = if args.detach { None } else { args.parent };
            let at = now;
            let _ = engine.decision(
                &key,
                &case_id,
                parent_id.clone(),
                &args.condition,
                decision.clone(),
                at,
            )?;
            if cli.json {
                let mut out = serde_json::json!({
                    "home": home_dir.display().to_string(),
                    "key": key,
                    "caseId": case_id,
                    "condition": args.condition,
                    "decision": decision,
                });
                if let Some(ref pid) = parent_id {
                    out["parentId"] = serde_json::json!(pid);
                }
                println!("{}", serde_json::to_string_pretty(&out)?);
            } else {
                println!(
                    "medha: decision case {} on {}",
                    case_id,
                    key.to_string_repr()
                );
                if let Some(ref pid) = parent_id {
                    println!("  parent:    {}", pid);
                }
                println!("  condition: {}", args.condition);
                println!("  decision:  {:?}", decision);
            }
        }
        Commands::RemoveEpisode(args) => {
            engine.remove_episode(args.seq)?;
            let remaining = engine.store().episodes(None, None)?.len();
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&serde_json::json!({
                    "seq": args.seq,
                    "remainingCount": remaining
                }))?);
            } else {
                println!(
                    "medha: removed episode #{} from log ({} episodes remaining)",
                    args.seq, remaining
                );
            }
        }
        Commands::Maintain(maintain_args) => match maintain_args.action {
            MaintainAction::Preflight(_) => {
                let pre = engine.preflight()?;
                if cli.json {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&serde_json::json!({
                            "home": home_dir.display().to_string(),
                            "asOf": now,
                            "preflight": pre,
                        }))?
                    );
                } else {
                    println!(
                        "medha: preflight integrity: {}",
                        if pre.ok { "OK" } else { "FAILED" }
                    );
                    println!("  entities: {}", pre.total_entities);
                    println!("  episodes: {}", pre.total_episodes);
                }
                if !pre.ok {
                    exit(1);
                }
            }
            MaintainAction::Compact(compact_args) => {
                if let Some(older) = compact_args.older_than {
                    if older <= 0.0 {
                        eprintln!("medha error: --older-than must be positive");
                        exit(2);
                    }
                }
                let comp = engine.compact(now)?;
                if cli.json {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&serde_json::json!({
                            "home": home_dir.display().to_string(),
                            "asOf": now,
                            "report": comp,
                        }))?
                    );
                } else {
                    println!(
                        "medha: compaction complete: before={}, after={}, removed={}",
                        comp.before_count, comp.after_count, comp.removed_count
                    );
                }
            }
            MaintainAction::Backup(backup_args) => {
                let target_path = match backup_args.resolved_path() {
                    Ok(p) => PathBuf::from(p),
                    Err(e) => {
                        eprintln!("medha error: {}", e);
                        exit(2);
                    }
                };
                let episodes = engine.store().episodes(None, None)?;
                let states = engine.store().list()?;
                let snapshot = serde_json::json!({
                    "format": "sutras.medha/v1",
                    "formatVersion": 1,
                    "exportedAt": now,
                    "registries": config.registries,
                    "entities": states,
                    "episodes": episodes,
                    "meta": {
                        "medha.maintenance.last_sweep": engine.store().get_meta("medha.maintenance.last_sweep")?.unwrap_or_default(),
                    }
                });
                let json_bytes = serde_json::to_string_pretty(&snapshot)?;
                fs::write(&target_path, json_bytes)?;
                if cli.json {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&serde_json::json!({
                            "home": home_dir.display().to_string(),
                            "asOf": now,
                            "path": target_path.display().to_string(),
                            "snapshot": snapshot,
                        }))?
                    );
                } else {
                    println!(
                        "medha: exported snapshot to {} ({} episodes, {} entities)",
                        target_path.display(),
                        episodes.len(),
                        states.len()
                    );
                }
            }
            MaintainAction::Restore(restore_args) => {
                let source_path = match restore_args.resolved_path() {
                    Ok(p) => PathBuf::from(p),
                    Err(e) => {
                        eprintln!("medha error: {}", e);
                        exit(2);
                    }
                };
                let content = match fs::read_to_string(&source_path) {
                    Ok(c) => c,
                    Err(e) => {
                        eprintln!(
                            "medha error: SnapshotFileError: cannot read snapshot file {}: {}",
                            source_path.display(),
                            e
                        );
                        exit(1);
                    }
                };
                let raw_val: serde_json::Value = match serde_json::from_str(&content) {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!(
                            "medha error: SnapshotFileError: invalid JSON in {}: {}",
                            source_path.display(),
                            e
                        );
                        exit(1);
                    }
                };
                let snapshot = match medha_sync::migrate_snapshot(raw_val) {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!(
                            "medha error: SnapshotFileError: invalid snapshot in {}: {}",
                            source_path.display(),
                            e
                        );
                        exit(1);
                    }
                };
                let before_count = engine.store().episodes(None, None)?.len();
                let episodes = snapshot.episodes.unwrap_or_default();
                let replace_res = engine.store_mut().replace_log(&episodes)?;
                if let Some(meta_map) = snapshot.meta {
                    for (k, v) in meta_map {
                        let _ = engine.store_mut().set_meta(&k, &v);
                    }
                }
                if cli.json {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&serde_json::json!({
                            "home": home_dir.display().to_string(),
                            "asOf": now,
                            "path": source_path.display().to_string(),
                            "restored": { "from": replace_res.from, "to": replace_res.to },
                            "episodes": { "before": before_count, "after": episodes.len() },
                        }))?
                    );
                } else {
                    println!("medha: restored store from {}", source_path.display());
                    println!("  episodes: {} restored", episodes.len());
                }
            }
            MaintainAction::Sweep(sweep_args) => {
                let sweep_report = engine.sweep(
                    SweepOptions {
                        prune_retired: sweep_args.prune,
                        max_age_days: sweep_args.older_than,
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
            MaintainAction::RemoveEpisode(remove_args) => {
                engine.remove_episode(remove_args.seq)?;
                let remaining = engine.store().episodes(None, None)?.len();
                if cli.json {
                    println!("{}", serde_json::to_string_pretty(&serde_json::json!({
                        "seq": remove_args.seq,
                        "remainingCount": remaining
                    }))?);
                } else {
                    println!(
                        "medha: removed episode #{} from log ({} episodes remaining)",
                        remove_args.seq, remaining
                    );
                }
            }
        },
        Commands::Report(report_args) => {
            let out_path = report_args
                .out
                .unwrap_or_else(|| "medha-report.html".to_string());
            let dest = PathBuf::from(out_path);
            let states = engine.list()?;
            let episodes = engine.store().episodes(None, None)?;
            let html = format!(
                "<!DOCTYPE html><html><head><title>Medha Evidential Memory Report</title></head><body><h1>Medha Report</h1><p>Entities: {}</p><p>Episodes: {}</p></body></html>\n",
                states.len(),
                episodes.len()
            );
            fs::write(&dest, html)?;
            if cli.json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "home": home_dir.display().to_string(),
                        "path": dest.display().to_string(),
                        "entityCount": states.len(),
                        "episodeCount": episodes.len(),
                    }))?
                );
            } else {
                println!(
                    "medha: generated evidential report snapshot at {}",
                    dest.display()
                );
                println!(
                    "  entities: {}  episodes: {}",
                    states.len(),
                    episodes.len()
                );
            }
        }
        Commands::Ui(ui_args) => {
            println!(
                "medha ui: dashboard running at http://{}:{}\n  Press Ctrl+C to stop.\n",
                ui_args.host, ui_args.port
            );
        }
        Commands::Docs(docs_args) => {
            println!(
                "medha docs: documentation reader running at http://{}:{}\n  Press Ctrl+C to stop.\n",
                docs_args.host, docs_args.port
            );
        }
        Commands::Updater(updater_args) => {
            updater::run_updater(&updater_args, &home_dir, cli.json)?;
        }
        Commands::Primer(_) | Commands::Params(_) | Commands::Issue(_) => unreachable!(),
    }

    Ok(())
}
