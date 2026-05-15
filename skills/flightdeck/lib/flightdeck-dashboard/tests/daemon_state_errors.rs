use std::error::Error;
use std::path::Path;

use flightdeck_dashboard::daemon::lifecycle::RuntimePaths;
use flightdeck_dashboard::daemon::state::{start_state_runtime, DaemonSnapshotSource};

const SESSION: &str = "s707";

#[tokio::test]
async fn pre_purge_surfaces_as_error_snapshot() -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let state_file = temp.path().join("flightdeck-state-s707.json");
    std::fs::write(
        &state_file,
        r#"{"session_id":"s707","issues":{"ISS-1":{"title":"old"}}}"#,
    )?;

    let snapshot = start_error_snapshot(temp.path(), &state_file).await?;
    assert!(snapshot.pre_purge_state);
    assert!(snapshot
        .master_error
        .as_deref()
        .is_some_and(|error| error.contains("pre-purge")));
    Ok(())
}

#[tokio::test]
async fn malformed_json_surfaces_as_error_snapshot() -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let state_file = temp.path().join("flightdeck-state-s707.json");
    std::fs::write(&state_file, "{not-json")?;

    let snapshot = start_error_snapshot(temp.path(), &state_file).await?;
    assert!(!snapshot.pre_purge_state);
    assert!(snapshot
        .master_error
        .as_deref()
        .is_some_and(|error| error.contains("failed to parse master state JSON")));
    Ok(())
}

#[tokio::test]
async fn missing_file_surfaces_as_error_snapshot() -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let state_file = temp.path().join("flightdeck-state-s707.json");

    let snapshot = start_error_snapshot(temp.path(), &state_file).await?;
    assert!(!snapshot.pre_purge_state);
    assert!(snapshot
        .master_error
        .as_deref()
        .is_some_and(|error| error.contains("state file missing")));
    assert!(!state_file.exists(), "runtime must not create master state");
    Ok(())
}

async fn start_error_snapshot(
    state_dir: &Path,
    state_file: &Path,
) -> Result<flightdeck_dashboard::state::snapshot::DashboardSnapshot, Box<dyn Error>> {
    let source = DaemonSnapshotSource::File {
        path: state_file.to_path_buf(),
        session: SESSION.to_owned(),
    };
    let runtime = start_state_runtime(
        source,
        RuntimePaths::new(state_dir.to_path_buf(), SESSION.to_owned()),
    )
    .await?;
    let snapshot = runtime.shared.snapshot.read().await.clone();
    Ok(snapshot)
}
