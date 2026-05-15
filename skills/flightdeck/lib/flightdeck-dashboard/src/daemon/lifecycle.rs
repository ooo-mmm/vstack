use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use fs2::FileExt;
use nix::errno::Errno;
use nix::sys::signal::{self, Signal};
use nix::unistd::Pid;
use thiserror::Error;

use crate::util::paths::{
    dashboard_lock_file, dashboard_log_file, dashboard_pid_file, dashboard_socket_file,
};

const READY_FD_ENV: &str = "FLIGHTDECK_DASHBOARD_READY_FD";
const READY_OK: &str = "READY\n";
const READY_ERR_PREFIX: &str = "ERR ";

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
    #[error("detached daemon failed before readiness: {0}")]
    Readiness(String),
    #[error("detached daemon argument contains NUL byte: {0}")]
    Nul(String),
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

pub struct ReadyNotifier {
    file: Option<File>,
}

impl ReadyNotifier {
    #[must_use]
    pub fn from_env() -> Option<Self> {
        let raw = std::env::var_os(READY_FD_ENV)?;
        std::env::remove_var(READY_FD_ENV);
        let fd = raw.into_vec();
        let fd = String::from_utf8(fd).ok()?.parse::<RawFd>().ok()?;
        if fd < 0 {
            return None;
        }
        // SAFETY: the fd is supplied by `spawn_detached` exclusively for this
        // exec'd daemon child. Taking ownership here ensures it closes after a
        // READY/ERR write and unblocks the waiting parent.
        let file = unsafe { File::from_raw_fd(fd) };
        Some(Self { file: Some(file) })
    }

    pub fn ready(&mut self) {
        self.write_and_close(READY_OK);
    }

    pub fn error(&mut self, message: impl AsRef<str>) {
        self.write_and_close(&format!("{READY_ERR_PREFIX}{}\n", message.as_ref()));
    }

    fn write_and_close(&mut self, message: &str) {
        if let Some(mut file) = self.file.take() {
            if let Err(error) = file.write_all(message.as_bytes()) {
                tracing::warn!(%error, "failed to notify detached daemon readiness");
            }
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
    let raw = Pid::from_raw(pid as i32);
    if signal::kill(raw, None).is_err() {
        return false;
    }
    !proc_state(pid).is_some_and(|state| state == 'Z')
}

pub fn stop_pid(pid: u32, grace: Duration) -> Result<(), LifecycleError> {
    let raw = Pid::from_raw(pid as i32);
    match signal::kill(raw, Signal::SIGTERM) {
        Ok(()) => {}
        Err(Errno::ESRCH) => return Ok(()),
        Err(error) => return Err(error.into()),
    }
    wait_until_dead(pid, grace);
    if !pid_alive(pid) {
        return Ok(());
    }
    match signal::kill(raw, Signal::SIGKILL) {
        Ok(()) | Err(Errno::ESRCH) => Ok(()),
        Err(error) => Err(error.into()),
    }
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
    let null = File::open("/dev/null").map_err(LifecycleError::Spawn)?;
    let mut pipe_fds = [0; 2];
    // SAFETY: `pipe` initializes both fd slots on success; pointers are valid
    // for two `c_int` values and live for the duration of the call.
    if unsafe { libc::pipe(pipe_fds.as_mut_ptr()) } != 0 {
        return Err(LifecycleError::Spawn(io::Error::last_os_error()));
    }
    let read_fd = pipe_fds[0];
    let write_fd = pipe_fds[1];

    let argv = build_argv(&exe, args)?;
    let env = build_env(write_fd)?;
    let argv_ptrs = cstring_ptrs(&argv);
    let env_ptrs = cstring_ptrs(&env);
    let exe_ptr = argv[0].as_ptr();
    let log_fd = log.as_raw_fd();
    let null_fd = null.as_raw_fd();

    // SAFETY: after fork, child paths call only async-signal-safe libc
    // functions and then `execve`/`_exit`. All argv/env CStrings and fd values
    // are prepared before forking and remain valid in the child copy.
    let first = unsafe { libc::fork() };
    if first < 0 {
        close_fd(read_fd);
        close_fd(write_fd);
        return Err(LifecycleError::Spawn(io::Error::last_os_error()));
    }
    if first == 0 {
        child_double_fork_and_exec(
            read_fd, write_fd, log_fd, null_fd, exe_ptr, &argv_ptrs, &env_ptrs,
        );
    }

    close_fd(write_fd);
    // SAFETY: parent owns the read end after closing its write end; wrapping it
    // in `File` transfers ownership so it closes on drop.
    let mut ready_reader = unsafe { File::from_raw_fd(read_fd) };
    let mut message = String::new();
    ready_reader
        .read_to_string(&mut message)
        .map_err(LifecycleError::Spawn)?;
    wait_for_first_child(first);
    match parse_ready_message(&message) {
        ReadyMessage::Ready => Ok(()),
        ReadyMessage::Error(message) => Err(LifecycleError::Readiness(message)),
        ReadyMessage::Empty => Err(LifecycleError::Readiness(
            "daemon exited before readiness".to_owned(),
        )),
    }
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

fn wait_until_dead(pid: u32, grace: Duration) {
    let start = Instant::now();
    while start.elapsed() < grace {
        if !pid_alive(pid) {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn proc_state(pid: u32) -> Option<char> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after_name = stat.rsplit_once(") ")?.1;
    after_name.chars().next()
}

fn build_argv(exe: &Path, args: &[String]) -> Result<Vec<CString>, LifecycleError> {
    let mut out = Vec::with_capacity(args.len() + 1);
    out.push(cstring_path(exe)?);
    for arg in args {
        out.push(CString::new(arg.as_bytes()).map_err(|_| LifecycleError::Nul(arg.clone()))?);
    }
    Ok(out)
}

fn build_env(write_fd: RawFd) -> Result<Vec<CString>, LifecycleError> {
    let mut out = Vec::new();
    for (key, value) in std::env::vars_os() {
        if key == READY_FD_ENV {
            continue;
        }
        let mut bytes = key.into_vec();
        bytes.push(b'=');
        bytes.extend(value.into_vec());
        out.push(CString::new(bytes).map_err(|_| LifecycleError::Nul("environment".to_owned()))?);
    }
    out.push(
        CString::new(format!("{READY_FD_ENV}={write_fd}"))
            .map_err(|_| LifecycleError::Nul(READY_FD_ENV.to_owned()))?,
    );
    Ok(out)
}

fn cstring_ptrs(values: &[CString]) -> Vec<*const libc::c_char> {
    values
        .iter()
        .map(|value| value.as_ptr())
        .chain(std::iter::once(std::ptr::null()))
        .collect()
}

fn cstring_path(path: &Path) -> Result<CString, LifecycleError> {
    CString::new(path.as_os_str().as_bytes())
        .map_err(|_| LifecycleError::Nul(path.display().to_string()))
}

enum ReadyMessage {
    Ready,
    Error(String),
    Empty,
}

fn parse_ready_message(message: &str) -> ReadyMessage {
    let message = message.trim();
    if message == READY_OK.trim() {
        ReadyMessage::Ready
    } else if let Some(error) = message.strip_prefix(READY_ERR_PREFIX) {
        ReadyMessage::Error(error.to_owned())
    } else if message.is_empty() {
        ReadyMessage::Empty
    } else {
        ReadyMessage::Error(message.to_owned())
    }
}

fn wait_for_first_child(pid: libc::pid_t) {
    let mut status = 0;
    // SAFETY: waiting on the direct first child pid from `fork`; status points
    // to valid stack memory for the duration of the syscall.
    unsafe {
        libc::waitpid(pid, &mut status, 0);
    }
}

fn child_double_fork_and_exec(
    read_fd: RawFd,
    write_fd: RawFd,
    log_fd: RawFd,
    null_fd: RawFd,
    exe_ptr: *const libc::c_char,
    argv_ptrs: &[*const libc::c_char],
    env_ptrs: &[*const libc::c_char],
) -> ! {
    close_fd(read_fd);
    // SAFETY: child process is single-threaded after fork; it forks once more
    // and both branches immediately `_exit` or continue to exec setup.
    let second = unsafe { libc::fork() };
    if second < 0 {
        write_ready_raw(write_fd, b"ERR second fork failed\n");
        exit_now(1);
    }
    if second > 0 {
        exit_now(0);
    }
    // SAFETY: libc calls operate on valid fds prepared before fork. Failure is
    // reported through the readiness pipe before exiting.
    unsafe {
        if libc::setsid() < 0 {
            write_ready_raw(write_fd, b"ERR setsid failed\n");
            exit_now(1);
        }
        if libc::chdir(c_path_root()) < 0 {
            write_ready_raw(write_fd, b"ERR chdir failed\n");
            exit_now(1);
        }
        if libc::dup2(null_fd, libc::STDIN_FILENO) < 0
            || libc::dup2(log_fd, libc::STDOUT_FILENO) < 0
            || libc::dup2(log_fd, libc::STDERR_FILENO) < 0
        {
            write_ready_raw(write_fd, b"ERR stdio redirect failed\n");
            exit_now(1);
        }
        libc::execve(exe_ptr, argv_ptrs.as_ptr(), env_ptrs.as_ptr());
    }
    write_ready_raw(write_fd, b"ERR exec failed\n");
    exit_now(127);
}

fn c_path_root() -> *const libc::c_char {
    static ROOT: &[u8] = b"/\0";
    ROOT.as_ptr().cast::<libc::c_char>()
}

fn write_ready_raw(fd: RawFd, message: &[u8]) {
    let mut written = 0;
    while written < message.len() {
        // SAFETY: fd is the readiness pipe write end; pointer and length are
        // derived from a live byte slice.
        let rc = unsafe {
            libc::write(
                fd,
                message[written..].as_ptr().cast::<libc::c_void>(),
                message.len() - written,
            )
        };
        if rc <= 0 {
            return;
        }
        written += rc as usize;
    }
}

fn close_fd(fd: RawFd) {
    // SAFETY: closing an owned/raw fd is safe; errors are intentionally ignored
    // during process setup/teardown because there is no recovery path.
    unsafe {
        libc::close(fd);
    }
}

fn exit_now(code: i32) -> ! {
    // SAFETY: called only in forked children where Rust destructors must not run.
    unsafe { libc::_exit(code) }
}

fn remove_file_if_exists(path: &Path, label: &str) {
    if let Err(error) = fs::remove_file(path) {
        if error.kind() != io::ErrorKind::NotFound {
            tracing::warn!(path = %path.display(), %error, label, "failed to remove daemon runtime file");
        }
    }
}
