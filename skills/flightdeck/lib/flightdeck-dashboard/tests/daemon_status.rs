use std::error::Error;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::Duration as StdDuration;

use flightdeck_dashboard::daemon::client::DaemonClient;
use serde_json::Value;
use tokio::time::{sleep, Duration, Instant};

const SESSION: &str = "s406";

#[tokio::test]
async fn detach_readiness_and_double_start_fail_fast() -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let state_file = temp.path().join("flightdeck-state-s406.json");
    write_state(&state_file)?;

    let start = daemon_command(
        temp.path(),
        [
            "daemon",
            "start",
            "--detach",
            "--session",
            SESSION,
            "--state-file",
            state_file.to_str().ok_or("state path must be utf-8")?,
        ],
    )?;
    assert!(
        start.status.success(),
        "detach start failed: {}",
        String::from_utf8_lossy(&start.stderr)
    );
    let socket = temp.path().join(format!("dashboard-{SESSION}.sock"));
    assert!(socket.exists(), "socket exists when detach command returns");
    assert!(
        DaemonClient::connect(&socket).await.is_ok(),
        "socket accepts connections when detach command returns"
    );

    let double_start = daemon_command(
        temp.path(),
        [
            "daemon",
            "start",
            "--detach",
            "--session",
            SESSION,
            "--state-file",
            state_file.to_str().ok_or("state path must be utf-8")?,
        ],
    )?;
    assert!(!double_start.status.success(), "double detach should fail");
    assert!(
        String::from_utf8_lossy(&double_start.stderr).contains("already running"),
        "double detach surfaces already-running error"
    );

    let stop = daemon_command(temp.path(), ["daemon", "stop", "--session", SESSION])?;
    assert!(
        stop.status.success(),
        "stop failed: {}",
        String::from_utf8_lossy(&stop.stderr)
    );
    wait_for_socket_removed(&socket).await?;
    Ok(())
}

#[tokio::test]
async fn daemon_stop_escalates_to_sigkill_when_signal_handler_wedged() -> Result<(), Box<dyn Error>>
{
    let temp = tempfile::tempdir()?;
    let state_file = temp.path().join("flightdeck-state-s406.json");
    write_state(&state_file)?;
    let mut daemon = spawn_wedged_daemon(temp.path(), &state_file).await?;

    let stop = Command::new(dashboard_bin())
        .args(["daemon", "stop", "--session", SESSION])
        .env("FD_STATE_DIR", temp.path())
        .env("FLIGHTDECK_DASHBOARD_STOP_GRACE_MS", "200")
        .output()?;
    assert!(
        stop.status.success(),
        "stop failed: {}",
        String::from_utf8_lossy(&stop.stderr)
    );
    let status = daemon.wait_for_exit();
    assert!(
        status.map(|status| !status.success()).unwrap_or(true),
        "wedged daemon should be killed by signal path"
    );
    assert!(!daemon.pid_file().exists(), "pid file removed after stop");
    assert!(!daemon.socket().exists(), "socket removed after stop");

    let stopped = daemon_command(temp.path(), ["daemon", "status", "--session", SESSION])?;
    let json: Value = serde_json::from_slice(&stopped.stdout)?;
    assert_eq!(json["running"], false);
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

    fn wait_for_exit(&mut self) -> Option<std::process::ExitStatus> {
        for _ in 0..50 {
            match self.child.try_wait() {
                Ok(Some(status)) => return Some(status),
                Ok(None) => thread::sleep(StdDuration::from_millis(100)),
                Err(error) => {
                    eprintln!("failed to poll daemon child: {error}");
                    return None;
                }
            }
        }
        if let Err(error) = self.child.kill() {
            eprintln!("failed to kill daemon child: {error}");
        }
        self.child.wait().ok()
    }
}

impl Drop for DaemonGuard {
    fn drop(&mut self) {
        match Command::new(dashboard_bin())
            .args(["daemon", "stop", "--session", SESSION])
            .env("FD_STATE_DIR", &self.state_dir)
            .env("FLIGHTDECK_DASHBOARD_STOP_GRACE_MS", "200")
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

async fn spawn_wedged_daemon(
    state_dir: &Path,
    state_file: &Path,
) -> Result<DaemonGuard, Box<dyn Error>> {
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
        .env("FLIGHTDECK_DASHBOARD_TEST_WEDGE_SIGNALS", "1")
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

async fn wait_for_socket_removed(socket: &Path) -> Result<(), Box<dyn Error>> {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if !socket.exists() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!("daemon socket was not removed: {}", socket.display()).into());
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

fn daemon_command<const N: usize>(
    state_dir: &Path,
    args: [&str; N],
) -> Result<std::process::Output, Box<dyn Error>> {
    Ok(Command::new(dashboard_bin())
        .args(args)
        .env("FD_STATE_DIR", state_dir)
        .output()?)
}

fn dashboard_bin() -> &'static str {
    env!("CARGO_BIN_EXE_flightdeck-dashboard")
}
