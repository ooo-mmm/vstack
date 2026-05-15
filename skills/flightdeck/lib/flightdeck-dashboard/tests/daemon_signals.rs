use std::error::Error;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::Duration as StdDuration;

use flightdeck_dashboard::daemon::client::DaemonClient;
use nix::sys::signal::{kill, Signal};
use nix::unistd::Pid;
use serde_json::Value;
use tokio::time::{sleep, Duration, Instant};

const SESSION: &str = "s405";

#[tokio::test]
async fn daemon_signals_cleanup_and_emit_exit_rows() -> Result<(), Box<dyn Error>> {
    for (signal, reason) in [
        (Signal::SIGTERM, "signal-term"),
        (Signal::SIGINT, "signal-int"),
        (Signal::SIGHUP, "signal-hup"),
    ] {
        let temp = tempfile::tempdir()?;
        let state_file = temp.path().join("flightdeck-state-s405.json");
        write_state(&state_file)?;
        let mut daemon = spawn_daemon(temp.path(), &state_file).await?;
        kill(Pid::from_raw(daemon.child.id() as i32), signal)?;
        daemon.wait_for_exit();

        assert!(
            !daemon.pid_file().exists(),
            "pid file removed for {signal:?}"
        );
        assert!(
            !daemon.socket().exists(),
            "socket file removed for {signal:?}"
        );
        let events = std::fs::read_to_string(daemon.events_file())?;
        let rows = events
            .lines()
            .map(serde_json::from_str::<Value>)
            .collect::<Result<Vec<_>, _>>()?;
        assert!(
            rows.iter().any(|row| {
                row["event_type"] == "daemon-exited"
                    && row["reason"] == reason
                    && row["details"]["reason"] == reason
            }),
            "daemon-exited row with reason {reason} exists"
        );
    }
    Ok(())
}

struct DaemonGuard {
    child: Child,
    state_dir: PathBuf,
}

impl DaemonGuard {
    fn socket(&self) -> PathBuf {
        self.state_dir.join(format!("dashboard-{SESSION}.sock"))
    }

    fn pid_file(&self) -> PathBuf {
        self.state_dir.join(format!("dashboard-{SESSION}.pid"))
    }

    fn events_file(&self) -> PathBuf {
        self.state_dir
            .join(format!("fd-daemon-events-{SESSION}.jsonl"))
    }

    fn wait_for_exit(&mut self) {
        for _ in 0..50 {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => thread::sleep(StdDuration::from_millis(100)),
                Err(error) => {
                    eprintln!("failed to poll daemon child: {error}");
                    return;
                }
            }
        }
        if let Err(error) = self.child.kill() {
            eprintln!("failed to kill daemon child: {error}");
        }
        if let Err(error) = self.child.wait() {
            eprintln!("failed to wait daemon child: {error}");
        }
    }
}

impl Drop for DaemonGuard {
    fn drop(&mut self) {
        match Command::new(dashboard_bin())
            .args(["daemon", "stop", "--session", SESSION])
            .env("FD_STATE_DIR", &self.state_dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
        {
            Ok(_) => {}
            Err(error) => eprintln!("failed to stop daemon in drop: {error}"),
        }
        self.wait_for_exit();
    }
}

async fn spawn_daemon(state_dir: &Path, state_file: &Path) -> Result<DaemonGuard, Box<dyn Error>> {
    let child = Command::new(dashboard_bin())
        .args([
            "daemon",
            "start",
            "--session",
            SESSION,
            "--state-file",
            state_file.to_str().ok_or("state path must be utf-8")?,
        ])
        .env("FD_STATE_DIR", state_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;
    let guard = DaemonGuard {
        child,
        state_dir: state_dir.to_path_buf(),
    };
    wait_for_socket(&guard.socket()).await?;
    Ok(guard)
}

async fn wait_for_socket(socket: &Path) -> Result<(), Box<dyn Error>> {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if socket.exists() && DaemonClient::connect(socket).await.is_ok() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!("daemon socket did not become ready: {}", socket.display()).into());
        }
        sleep(Duration::from_millis(50)).await;
    }
}

fn write_state(path: &Path) -> Result<(), Box<dyn Error>> {
    let json = format!(
        r#"{{
  "session_id": "{SESSION}",
  "updated_at": "2026-05-15T00:00:00Z",
  "entries": {{
    "agent-1": {{
      "id": "agent-1",
      "title": "initial",
      "state": "waiting"
    }}
  }}
}}"#
    );
    std::fs::write(path, json)?;
    Ok(())
}

fn dashboard_bin() -> &'static str {
    env!("CARGO_BIN_EXE_flightdeck-dashboard")
}
