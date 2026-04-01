use crate::config::{self, LockEntry, LockFile};
use anyhow::Result;

pub fn run() -> Result<()> {
    // Check CLI version
    let local_version = env!("CARGO_PKG_VERSION");
    let local_hash = env!("VSTACK_GIT_HASH");
    eprintln!("vstack {} ({})", local_version, local_hash);

    if let Some(remote_version) = crate::commands::update::get_remote_version() {
        if remote_version != local_version {
            eprintln!(
                "  CLI update available: {} → {}  (run: vstack update)",
                local_version, remote_version
            );
        } else {
            eprintln!("  CLI is up to date.");
        }
    }

    // Check installed items
    for global in [false, true] {
        let lock_path = config::lock_file_path(global);
        let lock = LockFile::load(&lock_path)?;

        let scope = if global { "global" } else { "project" };

        if lock.entries.is_empty() {
            continue;
        }

        eprintln!("\n{scope} scope: {} item(s)", lock.entries.len());

        let mut outdated = 0;
        for entry in lock.entries.values() {
            let status = check_staleness(entry);
            if status == "outdated" {
                outdated += 1;
            }
            let icon = match status {
                "ok" => "✓",
                "outdated" => "!",
                _ => "?",
            };
            eprintln!(
                "  {icon} {} ({}){}",
                entry.name,
                entry.kind,
                if status == "outdated" {
                    "  ← outdated"
                } else {
                    ""
                }
            );
        }

        if outdated > 0 {
            eprintln!("\n  {outdated} outdated — run `vstack add` to update");
        }
    }

    Ok(())
}

fn check_staleness(entry: &LockEntry) -> &'static str {
    if config::is_source_changed(entry) {
        "outdated"
    } else {
        "ok"
    }
}
