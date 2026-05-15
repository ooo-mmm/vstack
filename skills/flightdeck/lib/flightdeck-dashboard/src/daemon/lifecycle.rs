use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime};

use fs2::FileExt;
use nix::sys::signal::{self, Signal};
use nix::unistd::Pid;
use thiserror::Error;

use crate::util::paths::{
    dashboard_lock_file, dashboard_log_file, dashboard_pid_file, dashboard_socket_file,
};

#[derive(Debug, Error)]
pub enum LifecycleError {
    #[error("daemon already running pid={0:?}")]
    AlreadyRunning(Option<u32>),
    #[error("io error at {path}: {source}", path = path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("process signal failed: {0}")]
    Signal(#[from] nix::Error),
    #[error("failed to spawn detached daemon: {0}")]
    Spawn(io::Error),
}

pub struct DaemonLock {
    file: File,
    path: PathBuf,
}

impl DaemonLock {
    pub fn acquire(state_dir: &Path, session_key: &str) -> Result<Self, LifecycleError> {
        fs::create_dir_all(state_dir).map_err(|source| LifecycleError::Io {
            path: state_dir.to_path_buf(),
            source,
        })?;
        let path = dashboard_lock_file(state_dir, session_key);
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .map_err(|source| LifecycleError::Io {
                path: path.clone(),
                source,
            })?;
        file.try_lock_exclusive()
            .map_err(|_| LifecycleError::AlreadyRunning(read_pid(state_dir, session_key)))?;
        Ok(Self { file, path })
    }
}

impl Drop for DaemonLock {
    fn drop(&mut self) {
        if let Err(error) = fs2::FileExt::unlock(&self.file) {
            tracing::warn!(path = %self.path.display(), %error, "failed to unlock daemon lock");
        }
    }
}

#[derive(Debug, Clone)]
pub struct RuntimePaths {
    pub state_dir: PathBuf,
    pub session_key: String,
    pub pid: PathBuf,
    pub socket: PathBuf,
    pub log: PathBuf,
}

impl RuntimePaths {
    #[must_use]
    pub fn new(state_dir: PathBuf, session_key: String) -> Self {
        let pid = dashboard_pid_file(&state_dir, &session_key);
        let socket = dashboard_socket_file(&state_dir, &session_key);
        let log = dashboard_log_file(&state_dir, &session_key);
        Self {
            state_dir,
            session_key,
            pid,
            socket,
            log,
        }
    }
}

pub fn write_pid(paths: &RuntimePaths) -> Result<(), LifecycleError> {
    fs::write(&paths.pid, std::process::id().to_string()).map_err(|source| LifecycleError::Io {
        path: paths.pid.clone(),
        source,
    })
}

pub fn remove_pid(paths: &RuntimePaths) {
    remove_file_if_exists(&paths.pid, "pid file");
}

pub fn remove_socket(paths: &RuntimePaths) {
    remove_file_if_exists(&paths.socket, "socket");
}

pub fn read_pid(state_dir: &Path, session_key: &str) -> Option<u32> {
    let path = dashboard_pid_file(state_dir, session_key);
    read_pid_file(&path)
}

pub fn read_pid_file(path: &Path) -> Option<u32> {
    let mut text = String::new();
    File::open(path).ok()?.read_to_string(&mut text).ok()?;
    text.trim().parse().ok()
}

pub fn pid_alive(pid: u32) -> bool {
    signal::kill(Pid::from_raw(pid as i32), None).is_ok()
}

pub fn stop_pid(pid: u32, grace: Duration) -> Result<(), LifecycleError> {
    let pid = Pid::from_raw(pid as i32);
    signal::kill(pid, Signal::SIGTERM)?;
    let start = SystemTime::now();
    while start.elapsed().unwrap_or_default() < grace {
        if signal::kill(pid, None).is_err() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    signal::kill(pid, Signal::SIGKILL)?;
    Ok(())
}

pub fn spawn_detached(args: &[String], log_path: &Path) -> Result<(), LifecycleError> {
    let exe = std::env::current_exe().map_err(LifecycleError::Spawn)?;
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent).map_err(|source| LifecycleError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .map_err(|source| LifecycleError::Io {
            path: log_path.to_path_buf(),
            source,
        })?;
    let log_err = log.try_clone().map_err(|source| LifecycleError::Io {
        path: log_path.to_path_buf(),
        source,
    })?;
    let mut command = Command::new(exe);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(log_err);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: `pre_exec` runs only async-signal-safe `setsid` in the child
        // before exec; no Rust allocation or locks are touched in the closure.
        unsafe {
            command.pre_exec(|| nix::unistd::setsid().map(|_| ()).map_err(io::Error::other));
        }
    }
    command.spawn().map_err(LifecycleError::Spawn)?;
    Ok(())
}

pub fn append_log(path: &Path, message: &str) {
    match OpenOptions::new().create(true).append(true).open(path) {
        Ok(mut file) => {
            if let Err(error) = writeln!(file, "{}", message) {
                tracing::warn!(path = %path.display(), %error, "failed to write daemon log");
            }
        }
        Err(error) => tracing::warn!(path = %path.display(), %error, "failed to open daemon log"),
    }
}

fn remove_file_if_exists(path: &Path, label: &str) {
    if let Err(error) = fs::remove_file(path) {
        if error.kind() != io::ErrorKind::NotFound {
            tracing::warn!(path = %path.display(), %error, label, "failed to remove daemon runtime file");
        }
    }
}
