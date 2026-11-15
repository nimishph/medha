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

    #[command(
        about = "Lift a retirement or override quarantine, as a human decision with a reason (audited)"
    )]
    Reinstate(ReinstateArgs),

    #[command(about = "Retract a previously recorded episode by its sequence number")]
    Retract(RetractArgs),

    #[command(name = "remove-episode", about = "Directly remove a bad episode from the log and rebuild projection")]
    RemoveEpisode(RemoveEpisodeArgs),

    #[command(about = "Record a host-authored definition (title/tags/rationale) for an entity")]
    Define(DefineArgs),

    #[command(about = "Grow or edit a branch of an entity's decision tree")]
    Decision(DecisionArgs),

    #[command(about = "Engine maintenance: preflight, compact, backup, and restore")]
    Maintain(MaintainArgs),

    #[command(about = "Synchronize evidential memory across files or Git refs")]
    Sync(SyncArgs),

    #[command(about = "Launch the interactive evidential memory web dashboard")]
    Ui(UiArgs),

    #[command(about = "Generate an offline standalone HTML report of evidential memory")]
    Report(ReportArgs),

    #[command(about = "Launch the zero-dependency local documentation reader server")]
    Docs(DocsArgs),

    #[command(about = "Weight updater inspection, listing, and custom updater scaffolding")]
    Updater(UpdaterArgs),

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
        about = "Pack trusted, active and probation entities into a token budget (quarantined and retired are left out)"
    )]
    Pack(PackArgs),

    #[command(about = "Run Model Context Protocol (MCP) server over stdio")]
    Mcp(McpArgs),

    #[command(about = "Episode signing: keys, keyring, rotation, revocation and signing mode")]
    Keys(KeysArgs),

    #[command(about = "Evaluate regulated policy compliance, decision trees, and requireHumanFor gating")]
    Policy(PolicyArgs),
}

#[derive(Args, Debug, Default)]
pub struct ListArgs {
    #[arg(long, help = "Filter by kind")]
    pub kind: Option<String>,
    #[arg(long, help = "Filter by status")]
    pub status: Option<String>,
    #[arg(long, help = "Filter by namespace")]
    pub namespace: Option<String>,
    #[arg(
        long,
        help = "Filter: only these entity ids, comma-separated (e.g. the rules your host still has)"
    )]
    pub ids: Option<String>,
    #[arg(long, help = "Pagination limit")]
    pub limit: Option<usize>,
}

/// `--ids a,b,c` → the ids; an empty list is refused rather than matching nothing (gh-23).
pub fn parse_ids(raw: &str) -> Result<Vec<String>, String> {
    let ids: Vec<String> = raw
        .split(',')
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();
    if ids.is_empty() {
        return Err(format!(
            "Invalid --ids: expected a comma-separated list of entity ids, received '{raw}'"
        ));
    }
    Ok(ids)
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
    #[command(subcommand)]
    pub subcommand: Option<McpSubcommand>,
}

#[derive(Subcommand, Debug, Clone)]
pub enum McpSubcommand {
    #[command(about = "Start the stdio Model Context Protocol (MCP) server")]
    Serve,

    #[command(about = "Generate or write an MCP client registration from the built-in registry")]
    Config(McpConfigArgs),
}

#[derive(Args, Debug, Default, Clone)]
pub struct McpConfigArgs {
    #[arg(value_name = "CLIENT", help = "Client identifier (e.g. claude-code, cursor)")]
    pub client: Option<String>,

    #[arg(long, help = "List all supported MCP clients")]
    pub list: bool,

    #[arg(long, help = "Output configurations for all supported clients")]
    pub all: bool,

    #[arg(long, help = "Write configuration directly to client config file")]
    pub write: bool,

    #[arg(long, help = "Target scope (project | user | workspace)")]
    pub scope: Option<String>,

    #[arg(long, help = "Launcher type (path | npx)")]
    pub launcher: Option<String>,

    #[arg(long, help = "Server name in client config (default: medha)")]
    pub server_name: Option<String>,
}

#[derive(Args, Debug, Default)]
pub struct InitArgs {
    #[arg(
        long,
        default_value = "sqlite",
        help = "Storage backend (sqlite | memory | file)"
    )]
    pub backend: String,

    #[arg(long, help = "Storage backend alias")]
    pub store: Option<String>,

    #[arg(long, help = "Explicit path to the database file")]
    pub path: Option<String>,

    #[arg(long, help = "Path to registries configuration file")]
    pub config: Option<String>,

    #[arg(long, help = "Path to backup snapshot file")]
    pub backup: Option<String>,

    #[arg(long, help = "Wipe and recreate store")]
    pub recreate: bool,

    #[arg(long, help = "Custom agents instruction file")]
    pub agents_file: Option<String>,

    #[arg(long, help = "Skip agents instruction file")]
    pub no_agents_file: bool,

    #[arg(long, help = "Namespace scope for the store")]
    pub namespace: Option<String>,

    #[arg(long, help = "Disable default namespace scope")]
    pub no_namespace: bool,
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

    #[arg(
        long = "guard",
        help = "Guard type name (e.g. review, linter, tests). Required until the entity has one: a report against no guard would not count, so it is refused"
    )]
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

#[derive(Args, Debug, Clone)]
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
pub struct ReinstateArgs {
    #[arg(long, help = "Entity identifier")]
    pub id: String,

    #[arg(long, default_value = "rule", help = "Entity kind")]
    pub kind: String,

    #[arg(long, default_value = "", help = "Entity namespace")]
    pub namespace: String,

    #[arg(long, help = "Why a human is lifting the latch; kept in the audit log")]
    pub reason: String,
}

#[derive(Args, Debug)]
pub struct RetractArgs {
    #[arg(long, help = "Episode sequence number to retract")]
    pub seq: u64,

    #[arg(long, help = "Reason for the retraction")]
    pub reason: String,

    #[arg(
        long,
        help = "Entity the episode must belong to: a seq from another entity is refused"
    )]
    pub id: Option<String>,

    #[arg(long, default_value = "rule", help = "Entity kind (with --id)")]
    pub kind: String,

    #[arg(long, default_value = "", help = "Entity namespace (with --id)")]
    pub namespace: String,
}

#[derive(Args, Debug, Clone)]
pub struct SyncArgs {
    #[command(subcommand)]
    pub action: SyncAction,

    #[arg(long, global = true, help = "Path to shared sync JSON file")]
    pub file: Option<String>,

    #[arg(long, global = true, help = "Target Git remote")]
    pub remote: Option<String>,

    #[arg(long, global = true, help = "Target Git ref")]
    pub git_ref: Option<String>,

    #[arg(long, global = true, help = "Automatically import missing remote kinds and signals")]
    pub auto_import_registries: bool,
}

#[derive(Subcommand, Debug, Clone, PartialEq, Eq)]
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

#[derive(Args, Debug, Clone)]
pub struct CompactArgs {
    #[arg(long, help = "Age cutoff in days (default 90)")]
    pub older_than: Option<f64>,
}

#[derive(Args, Debug, Clone)]
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
        help = "Only these entity ids, comma-separated (keeps your host's rule set authoritative)"
    )]
    pub ids: Option<String>,

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

#[derive(Args, Debug, Default)]
pub struct DefineArgs {
    #[arg(long, help = "Entity identifier")]
    pub id: String,

    #[arg(long, default_value = "rule", help = "Entity kind (rule, recipe, tool)")]
    pub kind: String,

    #[arg(long, default_value = "", help = "Entity namespace")]
    pub namespace: String,

    #[arg(long, help = "Human-readable title")]
    pub title: String,

    #[arg(long, help = "Detailed rationale")]
    pub rationale: String,

    #[arg(long, help = "Comma-separated tags")]
    pub tags: Option<String>,

    #[arg(long, help = "Author identifier")]
    pub author: Option<String>,

    #[arg(long, help = "Historical timestamp (ISO 8601 or epoch ms) for backfilling")]
    pub at: Option<String>,
}

#[derive(Args, Debug, Default)]
pub struct DecisionArgs {
    #[arg(long, help = "Entity identifier")]
    pub id: String,

    #[arg(long, default_value = "rule", help = "Entity kind")]
    pub kind: String,

    #[arg(long, default_value = "", help = "Entity namespace")]
    pub namespace: String,

    #[arg(long, help = "Free-text condition this branch covers")]
    pub condition: String,

    #[arg(long, help = "Apply decision")]
    pub apply: bool,

    #[arg(long, help = "Ignore decision")]
    pub ignore: bool,

    #[arg(long, help = "Probability value in [0, 1]")]
    pub probability: Option<f64>,

    #[arg(long, help = "Existing parent branch id to nest under")]
    pub parent: Option<String>,

    #[arg(long = "case-id", help = "Existing branch id to edit in place")]
    pub case_id: Option<String>,

    #[arg(long, help = "Move this branch to the top level")]
    pub detach: bool,

    #[arg(long, help = "Author identifier")]
    pub author: Option<String>,

    #[arg(long, help = "Historical timestamp for backfilling")]
    pub at: Option<String>,
}

#[derive(Args, Debug, Clone)]
pub struct MaintainArgs {
    #[command(subcommand)]
    pub action: MaintainAction,
}

#[derive(Subcommand, Debug, Clone)]
pub enum MaintainAction {
    #[command(about = "Check store integrity, episode count, and registry match. Exits 1 on corrupt.")]
    Preflight(PreflightArgs),

    #[command(about = "Fold aged episode history into baseline snapshots and report the folded range.")]
    Compact(CompactArgs),

    #[command(about = "Export an atomic, portable MedhaSnapshot to a file.")]
    Backup(BackupArgs),

    #[command(about = "Replace store state headlessly with a previously exported MedhaSnapshot.")]
    Restore(RestoreArgs),

    #[command(about = "Prune or report retired and quarantined entities.")]
    Sweep(SweepArgs),

    #[command(name = "remove-episode", about = "Hard-delete an episode by sequence number.")]
    RemoveEpisode(RemoveEpisodeArgs),
}

#[derive(Args, Debug, Default, Clone)]
pub struct BackupArgs {
    #[arg(value_name = "PATH", help = "Destination file path for exported snapshot")]
    pub file_path: Option<String>,

    #[arg(long = "path", help = "Destination file path for exported snapshot")]
    pub opt_path: Option<String>,
}

impl BackupArgs {
    pub fn resolved_path(&self) -> Result<&str, String> {
        self.file_path
            .as_deref()
            .or(self.opt_path.as_deref())
            .ok_or_else(|| "Missing required snapshot path".to_string())
    }
}

#[derive(Args, Debug, Default, Clone)]
pub struct RestoreArgs {
    #[arg(value_name = "PATH", help = "Source file path of snapshot to restore")]
    pub file_path: Option<String>,

    #[arg(long = "path", help = "Source file path of snapshot to restore")]
    pub opt_path: Option<String>,
}

impl RestoreArgs {
    pub fn resolved_path(&self) -> Result<&str, String> {
        self.file_path
            .as_deref()
            .or(self.opt_path.as_deref())
            .ok_or_else(|| "Missing required snapshot path".to_string())
    }
}

#[derive(Args, Debug, Default, Clone)]
pub struct RemoveEpisodeArgs {
    #[arg(long, help = "Episode sequence number to remove")]
    pub seq: u64,

    #[arg(long, help = "Author identifier, kept in the removal audit trail")]
    pub author: Option<String>,

    #[arg(long, help = "Why the episode is removed, kept in the audit trail")]
    pub reason: Option<String>,
}

#[derive(Args, Debug, Clone)]
pub struct UpdaterArgs {
    #[command(subcommand)]
    pub action: UpdaterAction,
}

#[derive(Subcommand, Debug, Clone)]
pub enum UpdaterAction {
    #[command(about = "List registered weight updaters")]
    List,

    #[command(about = "Inspect a registered weight updater by name")]
    Show(UpdaterShowArgs),

    #[command(about = "Scaffold a custom TypeScript weight updater template from a base updater")]
    Fork(UpdaterForkArgs),
}

#[derive(Args, Debug, Default, Clone)]
pub struct UpdaterShowArgs {
    #[arg(value_name = "NAME", help = "Name of the weight updater to inspect")]
    pub name: String,
}

#[derive(Args, Debug, Default, Clone)]
pub struct UpdaterForkArgs {
    #[arg(value_name = "NAME", help = "Name of the weight updater to fork")]
    pub name: String,

    #[arg(long, help = "Destination file path for the scaffolded updater template")]
    pub out: Option<String>,
}

#[derive(Args, Debug, Default, Clone)]
pub struct ReportArgs {
    #[arg(long, help = "Output HTML file path (default: medha-report.html)")]
    pub out: Option<String>,
}

#[derive(Args, Debug, Default, Clone)]
pub struct UiArgs {
    #[arg(long, default_value_t = 3842, help = "Port to listen on")]
    pub port: u16,

    #[arg(long, default_value = "127.0.0.1", help = "Host address to bind")]
    pub host: String,

    #[arg(long, help = "Open the browser dashboard automatically")]
    pub open: bool,
}

#[derive(Args, Debug, Default, Clone)]
pub struct DocsArgs {
    #[arg(long, default_value_t = 3843, help = "Port to listen on")]
    pub port: u16,

    #[arg(long, default_value = "127.0.0.1", help = "Host address to bind")]
    pub host: String,

    #[arg(long, help = "Open the browser docs automatically")]
    pub open: bool,
}

#[derive(Args, Debug)]
pub struct KeysArgs {
    #[command(subcommand)]
    pub command: KeysSubcommand,
}

#[derive(Subcommand, Debug)]
pub enum KeysSubcommand {
    #[command(about = "Create an Ed25519 signing key")]
    Generate(KeysGenerateArgs),

    #[command(about = "List the keyring, the signing mode and the default key")]
    List(KeysListArgs),

    #[command(about = "Planned rotation: a new key for the same principal")]
    Rotate(KeysRotateArgs),

    #[command(about = "Compromise revocation: every episode the key signed stops counting")]
    Revoke(KeysRevokeArgs),

    #[command(about = "Verify every episode in the log against the keyring")]
    Verify(KeysVerifyArgs),

    #[command(about = "Set the signing mode: off | warn | require")]
    Mode(KeysModeArgs),

    #[command(about = "Endorse the existing (unsigned) log with maintainer-signed baselines")]
    Adopt(KeysAdoptArgs),
}

#[derive(Args, Debug)]
pub struct KeysGenerateArgs {
    #[arg(long, help = "Author principal this key signs as (e.g. agent:ci)")]
    pub principal: String,

    #[arg(long, help = "Comma-separated roles: agent, human, maintainer")]
    pub role: Option<String>,

    #[arg(long, help = "Comma-separated namespaces this key may sign in")]
    pub namespace: Option<String>,

    #[arg(long, help = "Free-form note stored with the key record")]
    pub comment: Option<String>,

    #[arg(long, help = "Make this the default signing key")]
    pub default: bool,

    #[arg(long, help = "Emit report as JSON")]
    pub json: bool,
}

#[derive(Args, Debug, Default)]
pub struct KeysListArgs {
    #[arg(long, help = "Emit report as JSON")]
    pub json: bool,
}

#[derive(Args, Debug)]
pub struct KeysRotateArgs {
    #[arg(help = "Key id to rotate out")]
    pub key_id: String,

    #[arg(long, help = "Emit report as JSON")]
    pub json: bool,
}

#[derive(Args, Debug)]
pub struct KeysRevokeArgs {
    #[arg(help = "Key id to revoke")]
    pub key_id: String,

    #[arg(long, help = "Why the key is revoked")]
    pub reason: String,

    #[arg(long, help = "Epoch ms: keep episodes signed with at < this")]
    pub trust_before: Option<i64>,

    #[arg(long, help = "Emit report as JSON")]
    pub json: bool,
}

#[derive(Args, Debug, Default)]
pub struct KeysVerifyArgs {
    #[arg(long, help = "Emit report as JSON")]
    pub json: bool,
}

#[derive(Args, Debug)]
pub struct KeysModeArgs {
    #[arg(help = "Signing mode: off | warn | require")]
    pub mode: String,

    #[arg(long, help = "Emit report as JSON")]
    pub json: bool,
}

#[derive(Args, Debug, Default)]
pub struct KeysAdoptArgs {
    #[arg(long, help = "Emit report as JSON")]
    pub json: bool,
}

#[derive(Args, Debug, Clone)]
pub struct PolicyArgs {
    /// Entity ID
    #[arg(long, help = "Entity ID")]
    pub id: String,

    /// Entity namespace
    #[arg(long, default_value = "", help = "Entity namespace")]
    pub namespace: String,

    /// Entity kind
    #[arg(long, default_value = "rule", help = "Entity kind")]
    pub kind: String,

    /// Context environment string, condition query, or JSON attributes map
    #[arg(long, help = "Context string or JSON map")]
    pub context: Option<String>,

    /// Author proposing the mutation (e.g. agent:worker, human:alice)
    #[arg(long, help = "Author proposing the mutation")]
    pub author: Option<String>,

    /// Specific mutation or action name proposed
    #[arg(long, help = "Action name or proposed mutation")]
    pub action: Option<String>,

    /// Minimum trust threshold required to allow execution
    #[arg(long, help = "Minimum trust threshold required")]
    pub min_trust: Option<f64>,
}
