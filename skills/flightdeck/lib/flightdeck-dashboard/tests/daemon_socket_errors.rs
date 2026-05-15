use std::error::Error;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::Duration as StdDuration;

use flightdeck_dashboard::daemon::client::DaemonClient;
use tokio::time::{sleep, timeout, Duration, Instant};

const SESSION: &str = "s606";

#[tokio::test]
async fn client_surfaces_disconnect() -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let state_file = temp.path().join("flightdeck-state-s606.json");
    write_state(&state_file)?;

    let bin = dashboard_bin();
    let mut daemon = spawn_daemon(bin, temp.path(), &state_file).await?;
    let socket = daemon.socket();
    let mut client = DaemonClient::connect(&socket).await?;
    let mut rx = client.subscribe_snapshots().await?;
    let first = timeout(Duration::from_secs(2), rx.recv())
        .await?
        .ok_or("subscription closed before initial snapshot")?;
    assert!(first.is_ok(), "initial snapshot should decode");

    let stop = Command::new(bin)
        .args(["daemon", "stop", "--session", SESSION])
        .env("FD_STATE_DIR", temp.path())
        .status()?;
    assert!(stop.success(), "stop command failed");
    daemon.wait_for_exit();

    let disconnect = timeout(Duration::from_secs(2), rx.recv())
        .await?
        .ok_or("subscription closed without surfaced error")?;
    assert!(disconnect.is_err(), "disconnect surfaces as channel error");
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
        let _ = Command::new(dashboard_bin())
            .args(["daemon", "stop", "--session", SESSION])
            .env("FD_STATE_DIR", &self.state_dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        self.wait_for_exit();
    }
}

async fn spawn_daemon(
    bin: &'static str,
    state_dir: &Path,
    state_file: &Path,
) -> Result<DaemonGuard, Box<dyn Error>> {
    let child = Command::new(bin)
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
    std::fs::write(
        path,
        r#"{
  "session_id": "s606",
  "updated_at": "2026-05-15T00:00:00Z",
  "entries": {
    "agent-1": {"id":"agent-1","title":"initial","state":"waiting"}
  }
}"#,
    )?;
    Ok(())
}

fn dashboard_bin() -> &'static str {
    env!("CARGO_BIN_EXE_flightdeck-dashboard")
}
