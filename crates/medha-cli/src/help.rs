//! The top-level `medha --help`, with commands in sections instead of one flat list.
//!
//! clap has no per-subcommand headings, so the sections are rendered into a help template built
//! from the real subcommand list: names and one-line descriptions come from the `Commands` enum and
//! cannot drift. Only the grouping lives here. It mirrors `cli/src/groups.ts` (the TypeScript CLI);
//! a command missing from `GROUPS` still appears, under "Other", and a unit test fails so it gets a
//! proper home.

use clap::Command;

/// Section title and the commands in it, in the order a newcomer meets them.
pub const GROUPS: &[(&str, &[&str])] = &[
    // `help` is clap's built-in subcommand; the TypeScript CLI handles it outside citty's registry.
    ("Get started", &["init", "primer", "params", "help"]),
    (
        "Record evidence",
        &[
            "propose",
            "record",
            "guard",
            "define",
            "decision",
            "retract",
            "remove-episode",
            "override",
        ],
    ),
    (
        "Look things up",
        &[
            "list",
            "show",
            "status",
            "drift",
            "hints",
            "explain-threshold",
            "simulate",
        ],
    ),
    ("Feed an agent", &["pack", "mcp"]),
    ("Dashboard and reports", &["ui", "report"]),
    (
        "Maintain and share",
        &[
            "maintain",
            "sweep",
            "compact",
            "preflight",
            "updater",
            "sync",
            "issue",
        ],
    ),
];

const OTHER: &str = "Other";

/// `(title, [(name, one-line description)])`, groups in order, empty ones dropped.
pub fn sections(cmd: &Command) -> Vec<(String, Vec<(String, String)>)> {
    // Build a copy so clap's generated `help` subcommand is listed, as the flat default list did.
    let mut cmd = cmd.clone();
    cmd.build();
    let available: Vec<(String, String)> = cmd
        .get_subcommands()
        .filter(|sub| !sub.is_hide_set())
        .map(|sub| {
            let about = sub
                .get_about()
                .map(|text| text.to_string())
                .unwrap_or_default();
            let first_line = about.lines().next().unwrap_or("").trim().to_string();
            (sub.get_name().to_string(), first_line)
        })
        .collect();

    let mut placed = vec![false; available.len()];
    let mut out = Vec::new();
    for (title, names) in GROUPS {
        let mut entries = Vec::new();
        for name in *names {
            if let Some(index) = available.iter().position(|(n, _)| n == name) {
                entries.push(available[index].clone());
                placed[index] = true;
            }
        }
        if !entries.is_empty() {
            out.push(((*title).to_string(), entries));
        }
    }
    let rest: Vec<(String, String)> = available
        .iter()
        .zip(&placed)
        .filter(|(_, done)| !**done)
        .map(|(entry, _)| entry.clone())
        .collect();
    if !rest.is_empty() {
        out.push((OTHER.to_string(), rest));
    }
    out
}

/// A clap help template for the root command with the commands laid out in sections.
pub fn grouped_template(cmd: &Command) -> String {
    let groups = sections(cmd);
    let width = groups
        .iter()
        .flat_map(|(_, entries)| entries.iter().map(|(name, _)| name.len()))
        .max()
        .unwrap_or(0);

    let mut text = String::from("{about}\n\n{usage-heading} {usage}\n");
    for (title, entries) in &groups {
        text.push_str(&format!("\n{}:\n", title.to_uppercase()));
        for (name, about) in entries {
            text.push_str(&format!("  {name:<width$}  {about}\n"));
        }
    }
    text.push_str("\nOptions:\n{options}\n\nUse `medha <command> --help` for more information about a command.\n");
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::args::Cli;
    use clap::CommandFactory;

    #[test]
    fn every_command_has_a_group() {
        let cmd = Cli::command();
        let other: Vec<String> = sections(&cmd)
            .into_iter()
            .filter(|(title, _)| title == OTHER)
            .flat_map(|(_, entries)| entries.into_iter().map(|(name, _)| name))
            .collect();
        assert!(other.is_empty(), "ungrouped commands: {other:?}");
    }

    #[test]
    fn no_command_is_in_two_groups() {
        let mut names: Vec<&str> = GROUPS.iter().flat_map(|(_, c)| c.iter().copied()).collect();
        let total = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), total);
    }

    #[test]
    fn grouped_help_lists_every_command_in_sections() {
        let mut cmd = Cli::command().help_template(grouped_template(&Cli::command()));
        let text = cmd.render_help().to_string();
        let mut last = 0;
        // Groups with no command in this binary (the Rust CLI has no `ui`) are not rendered.
        for (title, _) in sections(&Cli::command()) {
            let at = text
                .find(&title.to_uppercase())
                .unwrap_or_else(|| panic!("missing section {title}"));
            assert!(at >= last, "section {title} out of order");
            last = at;
        }
        for sub in Cli::command().get_subcommands() {
            let name = sub.get_name();
            assert!(
                text.lines().any(|l| l.starts_with(&format!("  {name} "))),
                "{name} missing from help:\n{text}"
            );
        }
        assert!(
            text.lines().any(|l| l.starts_with("  help ")),
            "built-in help subcommand missing from help:\n{text}"
        );
        assert!(text.contains("--home") && text.contains("--json"));
    }
}
