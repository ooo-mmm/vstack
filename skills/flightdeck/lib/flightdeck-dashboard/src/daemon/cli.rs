use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::Utc;
use color_eyre::eyre::{eyre, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::signal::unix::{signal, SignalKind};
use tokio::sync::broadcast;

use crate::cli::{DaemonAction, DaemonArgs, DaemonStartArgs, DaemonTailSource, SuperviseArgs};
use crate::daemon::busy::{self, BusyPaths};
use crate::daemon::client::DaemonClient;
use crate::daemon::lifecycle::{
    self, append_log, pid_alive, read_pid, remove_pid, remove_socket, stop_pid, write_pid,
    DaemonLock, ReadyNotifier, RuntimePaths,
};
use crate::daemon::socket;
use crate::daemon::state::{self, DaemonSnapshotSource};
use crate::daemon::subscribers::SubscriberRuntime;
use crate::state::tracked_entries::{self, SessionResolution};
use crate::util::paths::{
    dashboard_socket_file, fd_resolve_state_dir, fd_session_key_from_id, resolve_session_key,
};

const STOP_GRACE: Duration = Duration::from_secs(5);
const STOP_GRACE_ENV: &str = "FLIGHTDECK_DASHBOARD_STOP_GRACE_MS";

pub async fn run_daemon(args: DaemonArgs) -> Result<()> {
    match args.action {
        DaemonAction::Start(start) | DaemonAction::Foreground(start) => start_daemon(start).await,
        DaemonAction::Stop(args) => stop_daemon(args.session.as_deref()).await,
        DaemonAction::Status(args) => print_status(args.session.as_deref()).await,
        DaemonAction::Health(args) => print_health(args.session.as_deref()).await,
        DaemonAction::Events(args) => drain_events(args.session.as_deref(), false).await,
        DaemonAction::Ack(args) => drain_events(args.session.as_deref(), true).await,
        DaemonAction::Tail(args) => tail(args.session.as_deref(), args.source).await,
    }
}

pub async fn run_supervise(args: SuperviseArgs) -> Result<()> {
    start_daemon(DaemonStartArgs {
        detach: true,
        session: args.session,
        state_file: None,
    })
    .await
}

async fn start_daemon(args: DaemonStartArgs) -> Result<()> {
    let mut ready = ReadyNotifier::from_env();
    let result = start_daemon_inner(args, ready.as_mut()).await;
    if let Err(error) = &result {
        if let Some(notifier) = ready.as_mut() {
            notifier.error(error.to_string());
        }
    }
    result
}

async fn start_daemon_inner(
    args: DaemonStartArgs,
    ready: Option<&mut ReadyNotifier>,
) -> Result<()> {
    let state_dir = fd_resolve_state_dir();
    let source = resolve_source(args.session.as_deref(), args.state_file.as_deref())?;
    let session_key = resolve_runtime_session_key(args.session.as_deref(), &source)?;
    let paths = RuntimePaths::new(state_dir, session_key);
    if args.detach {
        let child_args = detached_args(&args)?;
        lifecycle::spawn_detached(&child_args, &paths.log)?;
        println!(
            "dashboard daemon detach ready session={} socket={}",
            paths.session_key,
            paths.socket.display()
        );
        return Ok(());
    }

    run_foreground(source, paths, ready).await
}

async fn run_foreground(
    source: DaemonSnapshotSource,
    paths: RuntimePaths,
    ready: Option<&mut ReadyNotifier>,
) -> Result<()> {
    let lock = match DaemonLock::acquire(&paths.state_dir, &paths.session_key) {
        Ok(lock) => lock,
        Err(error) => {
            eprintln!("{error}");
            return Err(error.into());
        }
    };
    let mut cleanup = DaemonCleanup::new(paths.clone(), lock);
    write_pid(&paths)?;
    remove_socket(&paths);
    append_log(&paths.log, "dashboard daemon starting");
    let state_runtime = state::start_state_runtime(source, paths.clone()).await?;
    let listener = socket::bind(&paths.socket)?;
    if let Some(notifier) = ready {
        notifier.ready();
    }
    let _subscriber_runtime = if rust_wake_enabled() {
        append_log(&paths.log, "dashboard daemon rust wake side active");
        Some(SubscriberRuntime::spawn(
            paths.clone(),
            state_runtime.shared.clone(),
        ))
    } else {
        append_log(
            &paths.log,
            "dashboard daemon rust wake side inactive gate=FLIGHTDECK_DAEMON_RUST",
        );
        None
    };
    let (shutdown_signal_tx, shutdown_signal_rx) = tokio::sync::oneshot::channel();
    let (shutdown_tx, mut shutdown_rx) = broadcast::channel::<()>(4);
    let mut socket_task = tokio::spawn(socket::serve(
        listener,
        state_runtime.shared.clone(),
        std::time::Instant::now(),
        shutdown_signal_rx,
        shutdown_tx.clone(),
    ));
    let mut sigterm = signal(SignalKind::terminate())?;
    let mut sigint = signal(SignalKind::interrupt())?;
    let mut sighup = signal(SignalKind::hangup())?;
    let wedge_signals = std::env::var_os("FLIGHTDECK_DASHBOARD_TEST_WEDGE_SIGNALS").is_some();

    let mut socket_finished = false;
    let reason = tokio::select! {
        _ = sigterm.recv(), if !wedge_signals => {
            append_log(&paths.log, "dashboard daemon shutdown signal=sigterm");
            ExitReason::SignalTerm
        }
        _ = sigint.recv(), if !wedge_signals => {
            append_log(&paths.log, "dashboard daemon shutdown signal=sigint");
            ExitReason::SignalInt
        }
        _ = sighup.recv(), if !wedge_signals => {
            append_log(&paths.log, "dashboard daemon shutdown signal=sighup");
            ExitReason::SignalHup
        }
        _ = shutdown_rx.recv() => {
            append_log(&paths.log, "dashboard daemon shutdown method=rpc");
            ExitReason::RpcShutdown
        }
        result = &mut socket_task => {
            socket_finished = true;
            match result {
                Ok(Ok(())) => {
                    append_log(&paths.log, "dashboard daemon socket task stopped");
                    ExitReason::SocketClosed
                }
                Ok(Err(error)) => {
                    append_log(&paths.log, &format!("dashboard daemon socket task failed error={error}"));
                    cleanup.set_reason(ExitReason::SocketClosed);
                    return Err(error.into());
                }
                Err(error) => {
                    append_log(&paths.log, &format!("dashboard daemon socket task join failed error={error}"));
                    cleanup.set_reason(ExitReason::SocketClosed);
                    return Err(error.into());
                }
            }
        }
    };
    cleanup.set_reason(reason);
    if !socket_finished {
        if shutdown_signal_tx.send(()).is_err() {
            tracing::debug!("daemon socket task already stopped");
        }
        socket_task.await??;
    }
    append_log(&paths.log, "dashboard daemon stopped");
    Ok(())
}

async fn stop_daemon(session: Option<&str>) -> Result<()> {
    let state_dir = fd_resolve_state_dir();
    let session_key = resolve_session_key_or_passthrough(session)?;
    if let Some(pid) = read_pid(&state_dir, &session_key) {
        if pid_alive(pid) {
            stop_pid(pid, stop_grace())?;
        }
    }
    let paths = RuntimePaths::new(state_dir, session_key);
    remove_pid(&paths);
    remove_socket(&paths);
    Ok(())
}

async fn print_status(session: Option<&str>) -> Result<()> {
    let state_dir = fd_resolve_state_dir();
    let session_key = resolve_session_key_or_passthrough(session)?;
    let pid = read_pid(&state_dir, &session_key).filter(|pid| pid_alive(*pid));
    let socket = dashboard_socket_file(&state_dir, &session_key);
    let status = json!({
        "session": session_key,
        "running": pid.is_some(),
        "pid": pid,
        "socket": socket.exists().then_some(socket),
        "uptime_secs": null,
    });
    println!("{}", serde_json::to_string(&status)?);
    Ok(())
}

async fn print_health(session: Option<&str>) -> Result<()> {
    let state_dir = fd_resolve_state_dir();
    let session_key = resolve_session_key_or_passthrough(session)?;
    let pid = read_pid(&state_dir, &session_key).filter(|pid| pid_alive(*pid));
    println!(
        "dashboard daemon {} pid={}",
        if pid.is_some() { "running" } else { "stopped" },
        pid.map(|pid| pid.to_string())
            .unwrap_or_else(|| "-".to_owned())
    );
    let log = RuntimePaths::new(state_dir, session_key).log;
    if let Ok(text) = std::fs::read_to_string(log) {
        for line in text
            .lines()
            .rev()
            .take(5)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
        {
            println!("{line}");
        }
    }
    Ok(())
}

async fn drain_events(session: Option<&str>, clear_pending: bool) -> Result<()> {
    let state_dir = fd_resolve_state_dir();
    let session_key = resolve_session_key_or_passthrough(session)?;
    let paths = BusyPaths::new(&state_dir, &session_key);
    let body = busy::with_session_lock(&paths, || busy::drain_events(&paths, clear_pending))?;
    print!("{body}");
    Ok(())
}

async fn tail(session: Option<&str>, source: DaemonTailSource) -> Result<()> {
    match source {
        DaemonTailSource::State => {
            let state_dir = fd_resolve_state_dir();
            let session_key = resolve_session_key_or_passthrough(session)?;
            let socket = dashboard_socket_file(&state_dir, &session_key);
            let mut client = DaemonClient::connect(&socket).await?;
            let mut rx = client.subscribe_snapshots().await?;
            while let Some(snapshot) = rx.recv().await {
                println!("{}", serde_json::to_string(&snapshot)?);
            }
        }
        DaemonTailSource::Events | DaemonTailSource::Wake => {
            return Err(eyre!(
                "tail source {:?} is not wired until subscriber absorption",
                source
            ));
        }
    }
    Ok(())
}

fn rust_wake_enabled() -> bool {
    std::env::var("FLIGHTDECK_DAEMON_RUST").is_ok_and(|value| value == "1")
}

fn stop_grace() -> Duration {
    std::env::var(STOP_GRACE_ENV)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or(STOP_GRACE)
}

fn resolve_source(
    session: Option<&str>,
    state_file: Option<&Path>,
) -> Result<DaemonSnapshotSource> {
    if let Some(path) = state_file {
        let session = session
            .map(str::to_owned)
            .unwrap_or_else(|| tracked_entries::session_id_from_state_path(path));
        return Ok(DaemonSnapshotSource::File {
            path: path.to_path_buf(),
            session,
        });
    }
    let resolution = tracked_entries::resolve_session_state(session)?;
    Ok(DaemonSnapshotSource::Session(resolution))
}

fn resolve_runtime_session_key(
    session: Option<&str>,
    source: &DaemonSnapshotSource,
) -> Result<String> {
    if let Some(session) = session {
        return Ok(resolve_session_key(session)?);
    }
    match source {
        DaemonSnapshotSource::Session(SessionResolution { session, .. }) => {
            resolve_session_key(session).map_err(Into::into)
        }
        DaemonSnapshotSource::File { session, .. } => Ok(file_session_key(session)),
    }
}

fn resolve_session_key_or_passthrough(session: Option<&str>) -> Result<String> {
    let Some(session) = session else {
        return Err(eyre!("--session required"));
    };
    resolve_session_key(session).map_err(Into::into)
}

fn file_session_key(session: &str) -> String {
    if session.starts_with('s') && session[1..].chars().all(|ch| ch.is_ascii_digit()) {
        session.to_owned()
    } else if session.starts_with('$') {
        fd_session_key_from_id(session)
    } else {
        session.to_owned()
    }
}

fn detached_args(args: &DaemonStartArgs) -> Result<Vec<String>> {
    let mut out = vec!["daemon".to_owned(), "start".to_owned()];
    if let Some(session) = &args.session {
        out.push("--session".to_owned());
        out.push(session.clone());
    }
    if let Some(state_file) = &args.state_file {
        out.push("--state-file".to_owned());
        out.push(absolute_path(state_file)?.display().to_string());
    }
    Ok(out)
}

fn absolute_path(path: &Path) -> Result<PathBuf> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}

#[derive(Debug, Clone, Copy)]
enum ExitReason {
    SignalTerm,
    SignalInt,
    SignalHup,
    RpcShutdown,
    SocketClosed,
    Other,
}

impl ExitReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::SignalTerm => "signal-term",
            Self::SignalInt => "signal-int",
            Self::SignalHup => "signal-hup",
            Self::RpcShutdown => "rpc-shutdown",
            Self::SocketClosed => "socket-closed",
            Self::Other => "other",
        }
    }
}

struct DaemonCleanup {
    paths: RuntimePaths,
    _lock: DaemonLock,
    reason: ExitReason,
}

impl DaemonCleanup {
    fn new(paths: RuntimePaths, lock: DaemonLock) -> Self {
        Self {
            paths,
            _lock: lock,
            reason: ExitReason::Other,
        }
    }

    fn set_reason(&mut self, reason: ExitReason) {
        self.reason = reason;
    }
}

impl Drop for DaemonCleanup {
    fn drop(&mut self) {
        remove_socket(&self.paths);
        remove_pid(&self.paths);
        emit_daemon_exited(&self.paths, self.reason);
    }
}

fn emit_daemon_exited(paths: &RuntimePaths, reason: ExitReason) {
    let busy_paths = BusyPaths::new(&paths.state_dir, &paths.session_key);
    if let Err(error) = busy::with_session_lock(&busy_paths, || {
        append_daemon_exited_row(&busy_paths, &paths.session_key, reason)
    }) {
        tracing::warn!(%error, "failed to emit daemon-exited event");
    }
}

fn append_daemon_exited_row(
    busy_paths: &BusyPaths,
    master_id: &str,
    reason: ExitReason,
) -> Result<(), busy::BusyError> {
    if let Some(parent) = busy_paths.events_file.parent() {
        std::fs::create_dir_all(parent).map_err(|source| busy::BusyError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    let ts = Utc::now().to_rfc3339();
    let reason = reason.as_str();
    let pid = std::process::id();
    let hash_input = format!("{ts}|{reason}|{master_id}|{pid}");
    let hash = format!("{:x}", Sha256::digest(hash_input.as_bytes()))
        .chars()
        .take(12)
        .collect::<String>();
    let row = json!({
        "ts": ts,
        "pane_id": master_id,
        "event_type": "daemon-exited",
        "reason": reason,
        "master_id": master_id,
        "pid": pid,
        "hash": hash,
        "tag": "daemon-exited",
        "stable_age_sec": 0,
        "details": {
            "event_type": "daemon-exited",
            "reason": reason,
            "master_id": master_id,
            "pid": pid,
        },
    });
    append_json_line(&busy_paths.events_file, &row)
}

fn append_json_line(path: &Path, row: &Value) -> Result<(), busy::BusyError> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|source| busy::BusyError::Io {
            path: path.to_path_buf(),
            source,
        })?;
    let body = serde_json::to_string(row).map_err(|source| busy::BusyError::Json {
        path: path.to_path_buf(),
        source,
    })?;
    writeln!(file, "{body}").map_err(|source| busy::BusyError::Io {
        path: path.to_path_buf(),
        source,
    })
}
