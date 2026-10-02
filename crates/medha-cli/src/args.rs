use clap::{Args, Parser, Subcommand, ValueEnum};
use medha::core::types::LifecycleStatus;

#[derive(Parser, Debug)]
#[command(name = "medha")]
#[command(author = "Nimish Phalnikar <https://github.com/nimishph>")]
#[command(version)]
#[command(about = "Evidential memory for rules, recipes and tools", long_about = None)]
pub struct Cli {
    #[arg(long, global = true, help = "Path to Medha home directory (.medha)")]
    pub home: Option<String>,

    #[arg(long, global = true, help = "Output response formatted as JSON")]
    pub json: bool,

    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Subcommand, Debug)]
pub enum Commands {
    #[command(about = "Initialize .medha/ directory and configuration")]
    Init(InitArgs),

    #[command(about = "Propose a candidate rule or entity (enters on probation)")]
    Propose(ProposeArgs),

    #[command(about = "Record a signal observation (APPLY, REJECT_RULE, etc.)")]
    Record(RecordArgs),

    #[command(about = "Report an automated test or guard verification check")]
    Guard(GuardArgs),

    #[command(about = "Show trust hint, evidence, and recent history for an entity")]
    Show(ShowArgs),

    #[command(about = "Explain which threshold bars are cleared and which are not")]
    ExplainThreshold(ExplainThresholdArgs),

    #[command(about = "Query trust hints for active context injection")]
    Hints(HintsArgs),

    #[command(about = "Simulate what happens if a signal were recorded")]
    Simulate(SimulateArgs),

    #[command(about = "Sweep stale, quarantined, or retired entities")]
    Sweep(SweepArgs),

    #[command(name = "override", about = "Explicitly override an entity's status")]
    Override(OverrideArgs),

    #[command(about = "Synchronize evidential memory across files or Git refs")]
    Sync(SyncArgs),

    #[command(about = "Compact historical episode logs into baseline state")]
    Compact(CompactArgs),

    #[command(about = "List entities matching kind / status / namespace / drift filters")]
    List(ListArgs),

    #[command(about = "Engine health: preflight, distribution by lifecycle status, drift count")]
    Status(StatusArgs),

    #[command(about = "Entities currently drifting, most-drifted first")]
    Drift(DriftArgs),

    #[command(about = "Verify store integrity and monotonic sequence order")]
    Preflight(PreflightArgs),

    #[command(about = "Token-frugal guidance on Medha concepts, architecture, and commands")]
    Primer(PrimerArgs),

    #[command(about = "Canonical model parameters and configured kind thresholds")]
    Params(ParamsArgs),

    #[command(about = "Prepare prefilled GitHub issue with sanitized diagnostics")]
    Issue(IssueArgs),

    #[command(
        about = "Pack active and probation entities into an evidential context window within token budget"
    )]
    Pack(PackArgs),

    #[command(about = "Run Model Context Protocol (MCP) server over stdio")]
    Mcp(McpArgs),
}

#[derive(Args, Debug, Default)]
pub struct ListArgs {
    #[arg(long, help = "Filter by kind")]
    pub kind: Option<String>,
    #[arg(long, help = "Filter by status")]
    pub status: Option<String>,
    #[arg(long, help = "Filter by namespace")]
    pub namespace: Option<String>,
    #[arg(long, help = "Pagination limit")]
    pub limit: Option<usize>,
}

#[derive(Args, Debug, Default)]
pub struct StatusArgs {}

#[derive(Args, Debug, Default)]
pub struct DriftArgs {
    #[arg(long, help = "Pagination limit")]
    pub limit: Option<usize>,
}

#[derive(Args, Debug, Default)]
pub struct McpArgs {
    #[arg(value_name = "ACTION", help = "Optional action (e.g. serve)")]
    pub action: Option<String>,
}

#[derive(Args, Debug)]
pub struct InitArgs {
    #[arg(
        long,
        default_value = "sqlite",
        help = "Storage backend (sqlite | memory)"
    )]
    pub backend: String,

    #[arg(long, help = "Explicit path to the database file")]
    pub path: Option<String>,
}

#[derive(Args, Debug)]
pub struct ProposeArgs {
    #[arg(long, help = "Entity identifier")]
    pub id: String,

    #[arg(
        long,
        default_value = "rule",
        help = "Entity kind (rule, recipe, tool)"
    )]
    pub kind: String,

    #[arg(long, default_value = "", help = "Entity namespace")]
    pub namespace: String,

    #[arg(long, help = "Source provenance of the proposal (e.g. review, linter)")]
    pub source: String,

    #[arg(long, help = "Baseline theta0 prior (default 0.5)")]
    pub theta0: Option<f64>,

    #[arg(long, help = "Description or prompt text")]
    pub description: Option<String>,
}

#[derive(Args, Debug)]
pub struct RecordArgs {
    #[arg(long, help = "Entity identifier")]
    pub id: String,

    #[arg(
        long,
        default_value = "rule",
        help = "Entity kind (rule, recipe, tool)"
    )]
    pub kind: String,

    #[arg(long, default_value = "", help = "Entity namespace")]
    pub namespace: String,

    #[arg(
        long,
        help = "Signal name (APPLY, REJECT_RULE, REJECT_CONTEXT, SKIP, etc.)"
    )]
    pub signal: String,

    #[arg(long, help = "Ensure entity is created if unknown")]
    pub ensure: bool,

    #[arg(long, help = "Author or agent identifier")]
    pub author: Option<String>,

    #[arg(long, help = "Run reference or commit")]
    pub run_ref: Option<String>,

    #[arg(long, help = "Note or rationale")]
    pub note: Option<String>,
}

#[derive(Args, Debug)]
pub struct GuardArgs {
    #[arg(long, help = "Entity identifier")]
    pub id: String,

    #[arg(
        long,
        default_value = "rule",
        help = "Entity kind (rule, recipe, tool)"
    )]
    pub kind: String,

    #[arg(long, default_value = "", help = "Entity namespace")]
    pub namespace: String,

    #[arg(long, help = "Guard check passed")]
    pub ok: bool,

    #[arg(long, conflicts_with = "ok", help = "Guard check failed")]
    pub fail: bool,

    #[arg(long = "guard", help = "Guard type name (e.g. review, linter, tests)")]
    pub guard_kind: Option<String>,

    #[arg(long, help = "Author or reviewer identifier")]
    pub author: Option<String>,

    #[arg(long, help = "Verification note")]
    pub note: Option<String>,
}

#[derive(Args, Debug)]
pub struct ShowArgs {
    #[arg(long, help = "Entity identifier")]
    pub id: String,

    #[arg(
        long,
        default_value = "rule",
        help = "Entity kind (rule, recipe, tool)"
    )]
    pub kind: String,

    #[arg(long, default_value = "", help = "Entity namespace")]
    pub namespace: String,
}

#[derive(Args, Debug)]
pub struct ExplainThresholdArgs {
    #[arg(long, help = "Entity identifier")]
    pub id: String,

    #[arg(
        long,
        default_value = "rule",
        help = "Entity kind (rule, recipe, tool)"
    )]
    pub kind: String,

    #[arg(long, default_value = "", help = "Entity namespace")]
    pub namespace: String,
}

#[derive(Args, Debug)]
pub struct HintsArgs {
    #[arg(long, help = "Filter by entity kind")]
    pub kind: Option<String>,

    #[arg(long, help = "Filter by namespace")]
    pub namespace: Option<String>,
}

#[derive(Args, Debug)]
pub struct SimulateArgs {
    #[arg(long, help = "Entity identifier")]
    pub id: String,

    #[arg(
        long,
        default_value = "rule",
        help = "Entity kind (rule, recipe, tool)"
    )]
    pub kind: String,

    #[arg(long, default_value = "", help = "Entity namespace")]
    pub namespace: String,

    #[arg(long, help = "Signal name to simulate")]
    pub signal: String,
}

#[derive(Args, Debug)]
pub struct SweepArgs {
    #[arg(long, help = "Prune retired entities completely")]
    pub prune: bool,

    #[arg(long, help = "Age cutoff in days")]
    pub older_than: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum CliStatus {
    Retired,
    Quarantined,
    Restore,
}

impl From<CliStatus> for LifecycleStatus {
    fn from(s: CliStatus) -> Self {
        match s {
            CliStatus::Retired => LifecycleStatus::Retired,
            CliStatus::Quarantined => LifecycleStatus::Quarantined,
            CliStatus::Restore => LifecycleStatus::Probation,
        }
    }
}

#[derive(Args, Debug)]
pub struct OverrideArgs {
    #[arg(long, help = "Entity identifier")]
    pub id: String,

    #[arg(long, default_value = "rule", help = "Entity kind")]
    pub kind: String,

    #[arg(long, default_value = "", help = "Entity namespace")]
    pub namespace: String,

    #[arg(
        long,
        value_enum,
        help = "Target status (retired | quarantined | restore)"
    )]
    pub status: CliStatus,

    #[arg(long, help = "Reason for the override")]
    pub reason: String,
}

#[derive(Args, Debug)]
pub struct SyncArgs {
    #[command(subcommand)]
    pub action: SyncAction,

    #[arg(long, help = "Path to shared sync JSON file")]
    pub file: Option<String>,

    #[arg(long, help = "Target Git remote")]
    pub remote: Option<String>,

    #[arg(long, help = "Target Git ref")]
    pub git_ref: Option<String>,
}

#[derive(Subcommand, Debug)]
pub enum SyncAction {
    #[command(about = "Check sync status")]
    Status,

    #[command(about = "Pull remote updates")]
    Pull,

    #[command(about = "Push local memory snapshot")]
    Push,

    #[command(about = "Reconcile two-way sync")]
    Reconcile,
}

#[derive(Args, Debug)]
pub struct CompactArgs {
    #[arg(long, help = "Age cutoff in days (default 90)")]
    pub older_than: Option<f64>,
}

#[derive(Args, Debug)]
pub struct PreflightArgs {}

#[derive(Args, Debug, Default)]
pub struct PrimerArgs {
    #[arg(
        value_name = "TOPIC",
        help = "Topic to explain (overview, mental-model, signals, guards, decisions, drift, config, sync)"
    )]
    pub topic: Option<String>,

    #[arg(long, help = "Render compact output without header or footer")]
    pub compact: bool,
}

#[derive(Args, Debug, Default)]
pub struct ParamsArgs {}

#[derive(Args, Debug, Default)]
pub struct IssueArgs {
    #[arg(value_name = "TITLE", help = "Optional title for the issue")]
    pub title: Option<String>,

    #[arg(long, default_value_t = true, action = clap::ArgAction::Set, help = "Open the issue in the default web browser")]
    pub open: bool,
}

#[derive(Args, Debug, Default)]
pub struct PackArgs {
    #[arg(long, required = true, help = "Maximum token/cost budget")]
    pub budget: usize,

    #[arg(long, help = "Filter by kind (default: rule)")]
    pub kind: Option<String>,

    #[arg(long, help = "Filter by namespace")]
    pub namespace: Option<String>,

    #[arg(
        long,
        help = "Proportion of budget for exploring probation entities (default: 0.15)"
    )]
    pub exploration: Option<f64>,

    #[arg(long, help = "Seed for deterministic exploration sampling")]
    pub seed: Option<u64>,

    #[arg(
        long,
        default_value = "markdown",
        help = "Output format: markdown, compact, or json"
    )]
    pub format: String,
}
