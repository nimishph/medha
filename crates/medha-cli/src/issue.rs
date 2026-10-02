use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IssueReport {
    pub title: String,
    pub url: String,
    pub body: String,
    #[serde(rename = "openedBrowser")]
    pub opened_browser: bool,
}

fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 2);
    for byte in input.bytes() {
        match byte {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            b' ' => out.push_str("%20"),
            _ => {
                out.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    out
}

pub fn create_issue_report(
    title_arg: Option<&str>,
    open_browser: bool,
    json: bool,
    store_stats: &str,
) -> IssueReport {
    let title = title_arg
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("Issue / Feedback")
        .to_string();

    let version = env!("CARGO_PKG_VERSION");
    let platform = std::env::consts::OS;
    let arch = std::env::consts::ARCH;

    let body = format!(
        "### Description\n\
         <!-- Describe the issue, unexpected behavior, or enhancement -->\n\n\
         ### Steps to Reproduce\n\
         1. \n\n\
         ### Expected Behavior\n\n\
         ### Diagnostics (Sanitized)\n\
         - **Medha Version**: {version}\n\
         - **Platform**: {platform} ({arch})\n\
         - **Runtime**: rust native binary\n\
         - **Store**: {store_stats}\n"
    );

    let encoded_title = percent_encode(&title);
    let encoded_body = percent_encode(&body);
    let url = format!(
        "https://github.com/nimishph/medha/issues/new?title={}&body={}",
        encoded_title, encoded_body
    );

    let mut opened = false;
    if open_browser && !json && std::env::var("CI").is_err() {
        #[cfg(target_os = "windows")]
        {
            let _ = std::process::Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-Command",
                    &format!("Start-Process '{}'", url),
                ])
                .spawn();
            opened = true;
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = std::process::Command::new("xdg-open").arg(&url).spawn();
            opened = true;
        }
    }

    IssueReport {
        title,
        url,
        body,
        opened_browser: opened,
    }
}

pub fn render_issue(report: &IssueReport) -> String {
    let mut out = vec![
        "medha: prepared issue on GitHub:".to_string(),
        format!("  title: {}", report.title),
        format!("  url:   {}", report.url),
    ];
    if report.opened_browser {
        out.push("  (opened in default browser)".to_string());
    }
    format!("{}\n", out.join("\n"))
}
