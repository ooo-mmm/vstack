use crate::config::{self, LockFile};
use crate::harness::Harness;
use crate::installer;
use anyhow::Result;

pub fn run(names: &[String], global: bool) -> Result<()> {
    if names.is_empty() {
        eprintln!("Usage: vstack remove <name> [<name>...]");
        return Ok(());
    }

    let lock_path = config::lock_file_path(global);
    let mut lock = LockFile::load(&lock_path).unwrap_or_default();

    for name in names {
        // Look up entry first to determine kind and harnesses
        let lock_entry = lock.entries.get(name.as_str()).cloned();
        let harnesses: Vec<Harness> = if let Some(ref entry) = lock_entry {
            entry
                .harnesses
                .iter()
                .filter_map(|h| Harness::from_id(h))
                .collect()
        } else {
            Harness::ALL.to_vec()
        };

        // Pi packages live in a separate location and are removed via
        // the dedicated helper. Also allow removing stale/manual Pi packages
        // that are present on disk or in settings but missing from the lock.
        let mut removed = Vec::new();
        let remove_as_pi_extension = matches!(
            lock_entry.as_ref().map(|e| e.kind),
            Some(crate::config::ItemKind::PiExtension)
        ) || (lock_entry.is_none()
            && crate::pi_extension::is_pi_extension_installed(name, global));
        if remove_as_pi_extension {
            removed.extend(crate::pi_extension::remove_pi_extension(name, global)?);
        } else {
            removed.extend(installer::remove_item(name, &harnesses, global)?);
        }

        if removed.is_empty() {
            if lock_entry.is_some() {
                eprintln!("  removed stale lock entry for {name}");
                lock.remove(name);
            } else {
                eprintln!("  {name}: not found");
            }
        } else {
            let pi_settings_path = config::pi_settings_path(global);
            for path in &removed {
                if path == &pi_settings_path {
                    eprintln!("  updated {}", path.display());
                } else {
                    eprintln!("  removed {}", path.display());
                }
            }
            lock.remove(name);
        }
    }

    lock.save(&lock_path)?;
    Ok(())
}
