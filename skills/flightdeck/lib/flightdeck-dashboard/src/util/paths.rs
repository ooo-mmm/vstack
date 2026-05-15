use std::path::{Path, PathBuf};
use std::process::Command;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum PathsError {
    #[error("session input is empty")]
    EmptySessionInput,
    #[error("failed to run tmux display-message for session {session:?}: {source}")]
    TmuxIo {
        session: String,
        #[source]
        source: std::io::Error,
    },
    #[error("tmux display-message failed for session {session:?} with status {status}")]
    TmuxStatus { session: String, status: String },
    #[error("tmux display-message returned empty session_id for session {0:?}")]
    EmptyTmuxSessionId(String),
}

/// Resolves the daemon runtime key (`sN`) for a tmux session input.
///
/// Mirrors `fdSessionKeyFromId` in `skills/flightdeck/lib/flightdeck-core/src/paths/daemon.ts`:
/// existing `sN` keys pass through, raw `$N` tmux session ids become `sN`,
/// and names are resolved once through `tmux display-message`.
pub fn resolve_session_key(input: &str) -> Result<String, PathsError> {
    resolve_session_key_with(input, tmux_session_id_for_name)
}

pub fn resolve_session_key_with<F>(input: &str, resolver: F) -> Result<String, PathsError>
where
    F: FnOnce(&str) -> Result<String, PathsError>,
{
    let input = input.trim();
    if input.is_empty() {
        return Err(PathsError::EmptySessionInput);
    }
    if is_session_key(input) {
        return Ok(input.to_owned());
    }
    if is_tmux_session_id(input) {
        return Ok(fd_session_key_from_id(input));
    }
    let session_id = resolver(input)?;
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Err(PathsError::EmptyTmuxSessionId(input.to_owned()));
    }
    Ok(fd_session_key_from_id(session_id))
}

#[must_use]
pub fn fd_session_key_from_id(id: &str) -> String {
    format!("s{}", id.trim().trim_start_matches('$'))
}

#[must_use]
pub fn fd_resolve_state_dir() -> PathBuf {
    if let Some(path) = std::env::var_os("FD_STATE_DIR").filter(|value| !value.is_empty()) {
        return absolutize_env_path(path);
    }
    if let Some(runtime) = std::env::var_os("XDG_RUNTIME_DIR").filter(|value| !value.is_empty()) {
        return PathBuf::from(runtime).join("flightdeck");
    }
    let uid = Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var("UID").ok())
        .unwrap_or_else(|| "0".to_owned());
    PathBuf::from(format!("/tmp/flightdeck-{uid}"))
}

#[must_use]
pub fn fd_log_file(state_dir: &Path, session_key: &str) -> PathBuf {
    state_dir.join(format!("fd-daemon-{session_key}.log"))
}

#[must_use]
pub fn dashboard_pid_file(state_dir: &Path, session_key: &str) -> PathBuf {
    state_dir.join(format!("dashboard-{session_key}.pid"))
}

#[must_use]
pub fn dashboard_lock_file(state_dir: &Path, session_key: &str) -> PathBuf {
    state_dir.join(format!("dashboard-{session_key}.lock"))
}

#[must_use]
pub fn dashboard_log_file(state_dir: &Path, session_key: &str) -> PathBuf {
    state_dir.join(format!("dashboard-{session_key}.log"))
}

#[must_use]
pub fn dashboard_socket_file(state_dir: &Path, session_key: &str) -> PathBuf {
    state_dir.join(format!("dashboard-{session_key}.sock"))
}

#[must_use]
pub fn fd_events_file(state_dir: &Path, session_key: &str) -> PathBuf {
    state_dir.join(format!("fd-daemon-events-{session_key}.jsonl"))
}

#[must_use]
pub fn fd_wake_events_log(state_dir: &Path, session_key: &str) -> PathBuf {
    state_dir.join(format!("fd-wake-events-{session_key}.log"))
}

fn is_session_key(input: &str) -> bool {
    input
        .strip_prefix('s')
        .is_some_and(|rest| !rest.is_empty() && rest.chars().all(|ch| ch.is_ascii_digit()))
}

fn is_tmux_session_id(input: &str) -> bool {
    input
        .strip_prefix('$')
        .is_some_and(|rest| !rest.is_empty() && rest.chars().all(|ch| ch.is_ascii_digit()))
}

fn absolutize_env_path(path: std::ffi::OsString) -> PathBuf {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(&path))
            .unwrap_or(path)
    }
}

fn tmux_session_id_for_name(session: &str) -> Result<String, PathsError> {
    let output = Command::new("tmux")
        .args(["display-message", "-p", "-t", session, "#{session_id}"])
        .output()
        .map_err(|source| PathsError::TmuxIo {
            session: session.to_owned(),
            source,
        })?;
    if !output.status.success() {
        return Err(PathsError::TmuxStatus {
            session: session.to_owned(),
            status: output.status.to_string(),
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::{resolve_session_key_with, PathsError};

    fn unused_resolver(_: &str) -> Result<String, PathsError> {
        panic!("resolver should not run for known forms")
    }

    #[test]
    fn resolve_session_key_known_forms() {
        assert_eq!(
            resolve_session_key_with("s17", unused_resolver).unwrap(),
            "s17"
        );
        assert_eq!(
            resolve_session_key_with("$17", unused_resolver).unwrap(),
            "s17"
        );
        assert_eq!(
            resolve_session_key_with("VS", |session| {
                assert_eq!(session, "VS");
                Ok("$23".to_owned())
            })
            .unwrap(),
            "s23"
        );
    }
}
