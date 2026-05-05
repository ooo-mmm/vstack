//! Shared test helpers. Anything that mutates process-global state (env vars,
//! cwd, etc.) lives here so the entire test suite serializes through one lock
//! instead of separate per-module locks racing against each other.

#![cfg(test)]

use std::path::Path;

/// Single global mutex guarding `PI_CODING_AGENT_DIR` mutations across the
/// whole crate. Tests in any module that need to redirect the Pi global dir
/// must go through `with_pi_dir`.
pub(crate) static PI_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Run `body` with `PI_CODING_AGENT_DIR` set to `pi_dir`, restoring the
/// previous value (or unsetting) afterwards. Tolerates a poisoned lock from a
/// prior panicking test so failures don't cascade across the whole suite.
pub(crate) fn with_pi_dir<R>(pi_dir: &Path, body: impl FnOnce() -> R) -> R {
    let guard = match PI_ENV_LOCK.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    let prev = std::env::var_os("PI_CODING_AGENT_DIR");
    unsafe {
        std::env::set_var("PI_CODING_AGENT_DIR", pi_dir);
    }
    let result = body();
    unsafe {
        if let Some(prev) = prev {
            std::env::set_var("PI_CODING_AGENT_DIR", prev);
        } else {
            std::env::remove_var("PI_CODING_AGENT_DIR");
        }
    }
    drop(guard);
    result
}
