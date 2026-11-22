// Every command returns the CLI's `Failure` (the TypeScript error shape) on its error path; it is
// large, but only built once, when a command fails, so boxing it buys nothing here.
#![allow(clippy::result_large_err)]

mod args;
mod failure;
mod help;
mod home_store;
mod init;
mod issue;
mod keys;
mod maintain;
mod mcp;
mod mcp_config;
mod pack;
mod params;
mod policy;
mod primer;
mod read;
mod render;
mod ts_view;
mod updater;
mod write;

use args::*;
use clap::{CommandFactory, FromArgMatches};
use medha::config::{MedhaConfig, CONFIG_FILE, MEDHA_HOME_DIR, SQLITE_FILE};
use medha::core::types::EntityKey;
use medha::store::StorePort;
use medha::{MedhaEngine, SweepOptions};
use render::*;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::exit;

fn main() {
    let command = Cli::command();
    let command = command
        .clone()
        .help_template(help::grouped_template(&command));
    let json_mode = env::args().any(|a| a == "--json");
    let matches = match command.try_get_matches() {
        Ok(m) => m,
        Err(err) => exit(usage_failure(err, json_mode)),
    };
    let cli = match Cli::from_arg_matches(&matches) {
        Ok(cli) => cli,
        Err(err) => exit(usage_failure(err, json_mode)),
    };
    if let Err(err) = run(cli) {
        exit(failure::classify(err.as_ref()).report(json_mode));
    }
}

/// clap's own rejections in the TypeScript CLI's error format. `--help` and `--version` are not
/// failures and keep clap's output. A missing or malformed argument value is an invalid argument
/// (exit 2), as in the TypeScript CLI; anything else clap rejects is a usage error (also exit 2).
fn usage_failure(err: clap::Error, json_mode: bool) -> i32 {
    use clap::error::{ContextKind, ErrorKind};
    match err.kind() {
        ErrorKind::DisplayHelp
        | ErrorKind::DisplayVersion
        | ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand => err.exit(),
        _ => {}
    }
    let rendered = err.render().to_string();
    let first = rendered
        .lines()
        .next()
        .unwrap_or("")
        .trim_start_matches("error: ")
        .to_string();
    let arg = err
        .get(ContextKind::InvalidArg)
        .map(|v| v.to_string())
        .unwrap_or_default();
    let flag = arg.split_whitespace().next().unwrap_or("").to_string();
    let failure = match err.kind() {
        ErrorKind::MissingRequiredArgument => {
            failure::Failure::invalid(&flag, "a value", "nothing")
        }
        ErrorKind::InvalidValue | ErrorKind::ValueValidation => {
            let value = err
                .get(ContextKind::InvalidValue)
                .map(|v| v.to_string())
                .unwrap_or_default();
            failure::Failure::invalid(&flag, "a valid value", value)
        }
        _ => failure::Failure::usage(first),
    };
    failure.report(json_mode)
}

/// The engine on a home's store: the backend config.json names, its registries, the namespace
/// scope when `scoped`, and git-ref sync when the project is a git repository.
fn open_engine(
    home_dir: &std::path::Path,
    config: &MedhaConfig,
    scoped: bool,
) -> Result<MedhaEngine<home_store::HomeStore>, Box<dyn std::error::Error>> {
    use medha::config::BackendKind;
    let default_file = match config.backend {
        BackendKind::File => "state.jsonl",
        _ => SQLITE_FILE,
    };
    let stored = config.path.as_deref().unwrap_or(default_file);
    let store_path = if std::path::Path::new(stored).is_absolute() {
        PathBuf::from(stored)
    } else {
        home_dir.join(stored)
    };
    let store = match config.backend {
        BackendKind::File => home_store::HomeStore::file(&store_path, config.registries.clone()),
        BackendKind::Sqlite => home_store::HomeStore::sqlite(&store_path, config.registries.clone()),
        BackendKind::Memory => {
            return Err(Box::new(
                failure::Failure::cli(
                    "HomeNotInitializedError",
                    "CLI_NOT_INITIALIZED",
                    format!("no engine home at {}", home_dir.display()),
                )
                .with_hint("run 'medha init' first (the ephemeral memory backend leaves nothing to reopen)"),
            ));
        }
    }
    .scoped(if scoped { config.namespace_scope.clone() } else { None });
    let mut engine = MedhaEngine::open_with(store, config.clone())?;
    engine.use_registries(&config.registries);
    let repo = if home_dir.file_name().is_some_and(|n| n == MEDHA_HOME_DIR) {
        home_dir.parent().unwrap_or(home_dir)
    } else {
        home_dir
    };
    let git = medha_sync::GitRefSyncAdapter::new(repo);
    if git.is_git_repo() {
        engine.set_sync(Box::new(git));
    }
    Ok(engine)
}

/// The Rust hints behind a pack outcome's `selected` or `rejected` list, in order.
fn report_items<'a>(
    outcome: &'a medha::core::packer::PackOutcome,
    list: &str,
) -> Vec<Option<&'a medha::core::types::TrustHint>> {
    match list {
        "selected" => outcome.selected.iter().map(|i| Some(&i.hint)).collect(),
        _ => outcome.rejected.iter().map(|_| None).collect(),
    }
}

/// An entity key from `--namespace/--kind/--id`; an empty id is an invalid argument (exit 2), as in
/// the TypeScript CLI's `keyFromFlags`.
pub(crate) fn key_from(
    namespace: &str,
    kind: &str,
    id: &str,
) -> Result<EntityKey, failure::Failure> {
    if id.is_empty() {
        return Err(failure::Failure::invalid(
            "--id",
            "a non-empty entity id",
            "",
        ));
    }
    Ok(EntityKey::new(namespace, kind, id))
}

/// A positive integer flag value (`--limit`, `--recent`); anything else is an invalid argument.
fn positive_int(name: &str, raw: &str) -> Result<usize, failure::Failure> {
    match raw.trim().parse::<f64>() {
        Ok(v) if v.fract() == 0.0 && (1.0..=9.007_199_254_740_991e15).contains(&v) => {
            Ok(v as usize)
        }
        _ => Err(failure::Failure::invalid(name, "a positive integer", raw)),
    }
}

/// The clock: `MEDHA_NOW` (epoch ms) pins it, as in the TypeScript CLI, so tests and replays are
/// deterministic; otherwise the system time.
pub(crate) fn clock_now() -> i64 {
    if let Ok(v) = env::var("MEDHA_NOW") {
        if let Ok(ms) = v.trim().parse::<f64>() {
            if ms.is_finite() {
                return ms as i64;
            }
        }
    }
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The engine home: `<dir>/<home>` when `--home` is given (relative to `--dir` or the current
/// directory), else `<dir>/.medha`. Without `--dir` or `--home` the search also walks up the parent
/// directories, so hooks running in a subdirectory still find the project's home.
fn home_path(dir: Option<&str>, explicit_home: Option<&str>) -> PathBuf {
    let base = dir
        .map(PathBuf::from)
        .or_else(|| env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."));
    match explicit_home {
        Some(h) => base.join(h),
        None => base.join(MEDHA_HOME_DIR),
    }
}

fn resolve_home(
    dir: Option<&str>,
    explicit_home: Option<&str>,
) -> Result<PathBuf, failure::Failure> {
    let home = home_path(dir, explicit_home);
    if home.join(CONFIG_FILE).is_file() {
        return Ok(home);
    }
    if dir.is_none() && explicit_home.is_none() {
        if let Some(found) = env::current_dir()
            .ok()
            .and_then(|c| MedhaConfig::find_home(&c))
        {
            if found.join(CONFIG_FILE).is_file() {
                return Ok(found);
            }
        }
    }
    Err(failure::Failure::cli(
        "HomeNotInitializedError",
        "CLI_NOT_INITIALIZED",
        format!("no engine home at {}", home.display()),
    )
    .with_context(serde_json::json!({ "home": home.display().to_string() }))
    .with_hint("run 'medha init' first (the ephemeral memory backend leaves nothing to reopen)"))
}

fn run(cli: Cli) -> Result<(), Box<dyn std::error::Error>> {
    let now = clock_now();

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
            let home = home_path(cli.dir.as_deref(), cli.home.as_deref());
            let specs = MedhaConfig::load_from_file(home.join(CONFIG_FILE))
                .ok()
                .map(|c| c.registries.kind_specs.clone());
            let report = params::params_report_ts(now, specs.as_deref());
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                print!("{}", params::render_params_ts(&report));
            }
            return Ok(());
        }
        Commands::Issue(issue_args) => {
            let maybe_home = resolve_home(cli.dir.as_deref(), cli.home.as_deref()).ok();
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
        let report = init::run(init_args, cli.dir.as_deref(), cli.home.as_deref(), now)?;
        if cli.json {
            println!("{}", serde_json::to_string_pretty(&report)?);
        } else {
            print!("{}", init::render(&report));
        }
        return Ok(());
    }

    // Resolve existing home
    let home_dir = resolve_home(cli.dir.as_deref(), cli.home.as_deref())?;
    let home_str = home_dir.display().to_string();

    let config = MedhaConfig::load_from_file(home_dir.join(CONFIG_FILE))?;

    // Open the store config.json commits to. Agent-facing commands run on the namespace-scoped
    // engine; host/admin commands (sync, maintenance, reports) see the whole store, as in the
    // TypeScript CLI's `openHome` (engine vs adminEngine).
    let admin = matches!(
        cli.command,
        Commands::Sync(_)
            | Commands::Maintain(_)
            | Commands::Compact(_)
            | Commands::Preflight(_)
            | Commands::Sweep(_)
            | Commands::Report(_)
            | Commands::Ui(_)
            | Commands::RemoveEpisode(_)
            | Commands::Keys(_)
    );
    let mut engine = open_engine(&home_dir, &config, !admin)?;

    match cli.command {
        Commands::Init(_) => unreachable!(),
        Commands::Propose(args) => {
            let key = key_from(&args.namespace, &args.kind, &args.id)?;
            let report = write::propose(&mut engine, &home_str, key.clone(), &args, now)?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                print!("{}", write::render_propose(&report, &key));
            }
        }
        Commands::Record(args) => {
            let key = key_from(&args.namespace, &args.kind, &args.id)?;
            let report = write::record(&mut engine, &home_str, key.clone(), &args, now)?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                print!("{}", write::render_record(&report, &key));
            }
        }
        Commands::Guard(args) => {
            let key = key_from(&args.namespace, &args.kind, &args.id)?;
            let report = write::guard(&mut engine, &home_str, key.clone(), &args, now)?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                print!("{}", write::render_guard(&report, &key));
            }
        }
        Commands::Show(args) => {
            let key = key_from(&args.namespace, &args.kind, &args.id)?;
            let recent = match &args.recent {
                Some(r) => positive_int("--recent", r)?,
                None => 10,
            };
            let report = ts_view::show_report(&engine, &home_str, &key, now, recent)?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                print!("{}", render_show_ts(&report));
            }
        }
        Commands::ExplainThreshold(args) => {
            let key = key_from(&args.namespace, &args.kind, &args.id)?;
            let report = read::explain_report(&engine, &home_str, &key, now)?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                print!("{}", read::render_explain(&report));
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
            let key = key_from(&args.namespace, &args.kind, &args.id)?;
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
            let key = key_from(&args.namespace, &args.kind, &args.id)?;
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
            let key = key_from(&args.namespace, &args.kind, &args.id)?;
            let report = write::reinstate(&mut engine, &home_str, key.clone(), &args, now)?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                print!("{}", write::render_reinstate(&report, &key));
            }
        }
        Commands::Retract(args) => {
            let report = write::retract(&mut engine, &home_str, &args, now)?;
            if let Some(w) = write::retract_warning(&report) {
                eprintln!("{w}");
            }
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                print!("{}", write::render_retract(&report));
            }
        }
        Commands::Sync(args) => {
            if let Some(ref f) = args.file {
                let p = PathBuf::from(f);
                if args.action == SyncAction::Pull && !p.exists() {
                    eprintln!(
                        "medha error: Cannot pull: sync file '{}' does not exist",
                        p.display()
                    );
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
                                        if !config
                                            .registries
                                            .signal_specs
                                            .iter()
                                            .any(|sig| sig.name == s.name)
                                        {
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
                                                if !updated_config
                                                    .registries
                                                    .signal_specs
                                                    .iter()
                                                    .any(|sig| sig.name == s.name)
                                                {
                                                    updated_config.registries.signal_specs.push(s);
                                                }
                                            }
                                            let _ = updated_config
                                                .save_to_file(home_dir.join(CONFIG_FILE));
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
                let git_ref = args
                    .git_ref
                    .as_deref()
                    .unwrap_or(medha_sync::DEFAULT_MEDHA_REF);
                let remote = args.remote.as_deref().unwrap_or(medha_sync::DEFAULT_REMOTE);
                let repo_dir = home_dir.parent().unwrap_or(&home_dir);
                engine.set_sync(Box::new(
                    medha_sync::GitRefSyncAdapter::with_ref_and_remote(repo_dir, git_ref, remote),
                ));
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
        Commands::Compact(compact_args) => {
            let report = maintain::compact(&mut engine, &home_str, compact_args.older_than, now)?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                print!("{}", maintain::render_compact(&report));
            }
        }
        Commands::Preflight(_) => {
            let report = maintain::preflight(&engine, &home_str, now)?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                print!("{}", maintain::render_preflight(&report));
            }
            if maintain::is_corrupt(&report) {
                exit(1);
            }
        }
        Commands::List(args) => {
            let ids = args
                .ids
                .as_deref()
                .map(parse_ids)
                .transpose()
                .map_err(|_| {
                    failure::Failure::invalid(
                        "--ids",
                        "a comma-separated list of entity ids",
                        args.ids.clone().unwrap_or_default(),
                    )
                })?;
            let limit = args
                .limit
                .as_deref()
                .map(|l| positive_int("--limit", l))
                .transpose()?;
            let report = read::list_report(
                &engine,
                &home_str,
                now,
                &read::ListOptions {
                    kind: args.kind.as_deref(),
                    status: args.status.as_deref(),
                    namespace: args.namespace.as_deref(),
                    drifting: if args.drifting { Some(true) } else { None },
                    ids,
                    limit,
                    cursor: args.cursor.as_deref(),
                },
            )?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                print!("{}", read::render_list(&report));
            }
        }
        Commands::Status(_) => {
            let backend = format!("{:?}", config.backend).to_lowercase();
            let path = config
                .path
                .as_deref()
                .map(|p| home_dir.join(p).display().to_string());
            let report = read::status_report(&engine, &home_str, &backend, path, now)?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                print!("{}", read::render_status(&report));
            }
            // Like `maintain preflight`: a corrupt store is reported, and the command exits 1.
            if report["preflight"]["status"] == "corrupt" {
                exit(1);
            }
        }
        Commands::Drift(args) => {
            let limit = args
                .limit
                .as_deref()
                .map(|l| positive_int("--limit", l))
                .transpose()?;
            let report = read::drift_report(&engine, &home_str, now, limit)?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                print!("{}", read::render_drift(&report));
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
                // The TypeScript PackReport: {home, budget, outcome (with TypeScript hints and its
                // own budget), format}.
                let mut outcome = serde_json::to_value(&report.outcome)?;
                for list in ["selected", "rejected"] {
                    let items = report_items(&report.outcome, list);
                    if let Some(arr) = outcome[list].as_array_mut() {
                        for (slot, hint) in arr.iter_mut().zip(items) {
                            if let Some(h) = hint {
                                slot["hint"] = ts_view::hint_of(&engine, h, now)?;
                            }
                        }
                    }
                }
                let mut ordered = serde_json::Map::new();
                for k in ["selected", "rejected"] {
                    ordered.insert(k.to_string(), outcome[k].take());
                }
                ordered.insert("budget".to_string(), serde_json::json!(report.budget));
                if let Some(rest) = outcome.as_object() {
                    for (k, v) in rest {
                        if !ordered.contains_key(k) {
                            ordered.insert(k.clone(), v.clone());
                        }
                    }
                }
                let json_report = serde_json::json!({
                    "home": report.home,
                    "budget": report.budget,
                    "outcome": ordered,
                    "format": report.format,
                });
                println!("{}", serde_json::to_string_pretty(&json_report)?);
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
            let key = key_from(&args.namespace, &args.kind, &args.id)?;
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
            let key = key_from(&args.namespace, &args.kind, &args.id)?;
            let report = write::decision(&mut engine, &home_str, key.clone(), &args, now)?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                print!("{}", write::render_decision(&report, &key));
            }
        }
        Commands::RemoveEpisode(args) => {
            let report = write::remove_episode(&mut engine, &home_str, &args, now)?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                print!("{}", write::render_remove_episode(&report));
            }
        }
        Commands::Maintain(maintain_args) => match maintain_args.action {
            MaintainAction::Preflight(_) => {
                let report = maintain::preflight(&engine, &home_str, now)?;
                if cli.json {
                    println!("{}", serde_json::to_string_pretty(&report)?);
                } else {
                    print!("{}", maintain::render_preflight(&report));
                }
                if maintain::is_corrupt(&report) {
                    exit(1);
                }
            }
            MaintainAction::Compact(compact_args) => {
                let report =
                    maintain::compact(&mut engine, &home_str, compact_args.older_than, now)?;
                if cli.json {
                    println!("{}", serde_json::to_string_pretty(&report)?);
                } else {
                    print!("{}", maintain::render_compact(&report));
                }
            }
            MaintainAction::Backup(backup_args) => {
                let path = backup_args.resolved_path().unwrap_or("").to_string();
                let registries = serde_json::to_value(&config.registries)?;
                let report = maintain::backup(&engine, &home_str, &registries, &path, now)?;
                if cli.json {
                    println!("{}", serde_json::to_string_pretty(&report)?);
                } else {
                    print!("{}", maintain::render_backup(&report));
                }
            }
            MaintainAction::Restore(restore_args) => {
                let path = restore_args.resolved_path().unwrap_or("").to_string();
                let report = maintain::restore(&mut engine, &home_str, &path, now)?;
                if cli.json {
                    println!("{}", serde_json::to_string_pretty(&report)?);
                } else {
                    print!("{}", maintain::render_restore(&report));
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
                let report = write::remove_episode(&mut engine, &home_str, &remove_args, now)?;
                if cli.json {
                    println!("{}", serde_json::to_string_pretty(&report)?);
                } else {
                    print!("{}", write::render_remove_episode(&report));
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
                println!("  entities: {}  episodes: {}", states.len(), episodes.len());
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
