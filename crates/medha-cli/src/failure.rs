//! CLI failures in the TypeScript CLI's shape (`cli/src/cli.ts` and `cli/src/errors.ts`).
//!
//! Text mode prints `error: <message>`, an optional `hint: <hint>` and `(<CODE>)` on stderr; with
//! `--json` the error is one JSON object on stderr (`name`, `code`, `subsystem`, `message`,
//! `context`, `hint`). Exit code 2 is usage (a bad command line or an invalid argument value), 1 is
//! everything else. Hosts match on the codes, so they are the TypeScript ones.

use medha::core::types::CoreError;
use medha::store::errors::StoreError;
use medha::MedhaError;
use serde_json::{json, Value};
use std::fmt;

pub const INVALID_ARGUMENT: &str = "CORE_INVALID_ARGUMENT";
pub const UNKNOWN_REGISTRY_ENTRY: &str = "CORE_UNKNOWN_REGISTRY_ENTRY";
pub const CLI_USAGE: &str = "CLI_USAGE";

#[derive(Debug, Clone)]
pub struct Failure {
    pub name: String,
    pub code: String,
    pub subsystem: String,
    pub message: String,
    pub hint: Option<String>,
    pub context: Value,
}

impl Failure {
    pub fn new(name: &str, code: &str, subsystem: &str, message: impl Into<String>) -> Self {
        Failure {
            name: name.to_string(),
            code: code.to_string(),
            subsystem: subsystem.to_string(),
            message: message.into(),
            hint: None,
            context: json!({}),
        }
    }

    /// `InvalidArgumentError`: "Invalid <name>: expected <expected>, received <received>".
    pub fn invalid(name: &str, expected: &str, received: impl fmt::Display) -> Self {
        Failure::new(
            "InvalidArgumentError",
            INVALID_ARGUMENT,
            "core",
            format!("Invalid {name}: expected {expected}, received {received}"),
        )
        .with_context(
            json!({ "name": name, "expected": expected, "received": received.to_string() }),
        )
    }

    /// A CLI-domain failure (`CLI_*` codes), e.g. `CLI_NOT_INITIALIZED`.
    pub fn cli(name: &str, code: &str, message: impl Into<String>) -> Self {
        Failure::new(name, code, "cli", message)
    }

    pub fn usage(message: impl Into<String>) -> Self {
        Failure::cli("CliUsageError", CLI_USAGE, message)
    }

    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    pub fn with_context(mut self, context: Value) -> Self {
        self.context = context;
        self
    }

    pub fn exit_code(&self) -> i32 {
        if self.code == INVALID_ARGUMENT || self.code == CLI_USAGE {
            2
        } else {
            1
        }
    }

    pub fn to_json(&self) -> Value {
        let mut v = json!({
            "name": self.name,
            "code": self.code,
            "subsystem": self.subsystem,
            "message": self.message,
            "context": self.context,
        });
        if let Some(h) = &self.hint {
            v["hint"] = json!(h);
        }
        v
    }

    /// Print to stderr in the TypeScript CLI's format and return the exit code.
    pub fn report(&self, json_mode: bool) -> i32 {
        if json_mode {
            eprintln!(
                "{}",
                serde_json::to_string_pretty(&self.to_json()).unwrap_or_default()
            );
        } else {
            eprintln!("error: {}", self.message);
            if let Some(h) = &self.hint {
                eprintln!("hint: {h}");
            }
            eprintln!("({})", self.code);
        }
        self.exit_code()
    }
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for Failure {}

fn unknown_entry(kind: &str, name: &str) -> Failure {
    Failure::new(
        if kind == "signal" {
            "UnknownSignalError"
        } else {
            "UnknownKindError"
        },
        UNKNOWN_REGISTRY_ENTRY,
        "core",
        format!("Unknown {kind} '{name}'"),
    )
    .with_context(json!({ "kind": kind, "name": name }))
}

/// `Unknown signal 'X'` / `Unknown kind 'X'` inside an invalid-argument reason.
fn registry_entry_in(reason: &str) -> Option<Failure> {
    for kind in ["signal", "kind"] {
        let prefix = format!("Unknown {kind} '");
        if let Some(rest) = reason.strip_prefix(&prefix) {
            let name = rest.split('\'').next().unwrap_or("");
            return Some(unknown_entry(kind, name));
        }
    }
    None
}

fn invalid_reason(name: &str, reason: &str) -> Failure {
    if let Some(f) = registry_entry_in(reason) {
        return f;
    }
    // Engine reasons may carry a hint after a "\nhint: " separator.
    if let Some((head, hint)) = reason.split_once("\nhint: ") {
        return invalid_reason(name, head).with_hint(hint);
    }
    // Engine reasons are free text ("expected ..., received ..." or a sentence); keep them whole.
    let arg = if name.starts_with('-') || name.contains('.') {
        name.to_string()
    } else {
        format!("--{}", name.replace('_', "-"))
    };
    Failure::new(
        "InvalidArgumentError",
        INVALID_ARGUMENT,
        "core",
        format!("Invalid {arg}: {reason}"),
    )
    .with_context(json!({ "name": arg, "reason": reason }))
}

fn from_core(err: &CoreError) -> Failure {
    match err {
        CoreError::InvalidArgument { name, reason } => invalid_reason(name, reason),
        CoreError::UnknownSignal(s) => unknown_entry("signal", s),
        CoreError::UnknownKind(k) => unknown_entry("kind", k),
        other => Failure::new(
            "UnexpectedFailureError",
            "CORE_UNEXPECTED_FAILURE",
            "core",
            other.to_string(),
        ),
    }
}

fn from_store(err: &StoreError) -> Failure {
    match err {
        StoreError::InvalidArgument { name, reason } => invalid_reason(name, reason),
        StoreError::Core(c) => from_core(c),
        StoreError::CorruptStore { store_path, at_seq, .. } => Failure::cli(
            "StoreCorruptError",
            "CLI_STORE_CORRUPT",
            format!("store is corrupt — the log is unrecoverable from seq {at_seq}"),
        )
        .with_context(json!({ "source": store_path, "atSeq": at_seq }))
        .with_hint("restore a MedhaSnapshot, or wipe and re-initialize with --recreate"),
        StoreError::NamespaceViolation { action, namespace, allowed } => Failure::new(
            "NamespaceViolationError",
            "STORE_NAMESPACE_VIOLATION",
            "store",
            err.to_string(),
        )
        .with_context(json!({ "action": action, "namespace": namespace, "allowed": allowed })),
        StoreError::StoreLayout { found, supported } => Failure::new(
            "StoreLayoutError",
            "STORE_LAYOUT_UNSUPPORTED",
            "store",
            format!("Store layout version {found} is not supported by this build (supports up to {supported})"),
        ),
        other => Failure::new("UnexpectedFailureError", "CORE_UNEXPECTED_FAILURE", "store", other.to_string()),
    }
}

/// Classify any error `run` returned.
pub fn classify(err: &(dyn std::error::Error + 'static)) -> Failure {
    if let Some(f) = err.downcast_ref::<Failure>() {
        return f.clone();
    }
    if let Some(m) = err.downcast_ref::<MedhaError>() {
        return match m {
            MedhaError::InvalidArgument { name, reason } => invalid_reason(name, reason),
            MedhaError::Core(c) => from_core(c),
            MedhaError::Store(s) => from_store(s),
            MedhaError::PermissionDenied(msg) => Failure::new(
                "PermissionDeniedError",
                "CORE_PERMISSION_DENIED",
                "core",
                msg.clone(),
            ),
            MedhaError::Config(msg) => {
                Failure::cli("ConfigFileError", "CLI_CONFIG_INVALID", msg.clone())
            }
            other => Failure::new(
                "UnexpectedFailureError",
                "CORE_UNEXPECTED_FAILURE",
                "core",
                other.to_string(),
            ),
        };
    }
    if let Some(c) = err.downcast_ref::<CoreError>() {
        return from_core(c);
    }
    if let Some(s) = err.downcast_ref::<StoreError>() {
        return from_store(s);
    }
    Failure::new(
        "UnexpectedFailureError",
        "CORE_UNEXPECTED_FAILURE",
        "core",
        err.to_string(),
    )
}
