use std::error::Error;

use super::common::pi_daemon::*;

#[tokio::test]
async fn pi_subscriber_pid_marker_records_bridge_child_and_cleans_on_abort(
) -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let state_file = temp.path().join("flightdeck-state-s505.json");
    write_state(&state_file, "issue")?;
    let bridge_pid_file = temp.path().join("bridge-child-pid");
    let bridge = write_fake_bridge(
        temp.path(),
        r#"
if [[ "$1" == "stream" ]]; then
  printf '%s\n' "$$" > "${FD_FAKE_CHILD_PID:?}"
  while true; do sleep 1; done
fi
exit 0
"#,
    )?;

    let mut daemon = spawn_daemon(
        temp.path(),
        &state_file,
        &bridge,
        &[("FD_FAKE_CHILD_PID", bridge_pid_file.as_path())],
    )
    .await?;

    let pid_path = subscriber_pid_path(temp.path());
    let bridge_pid = wait_for_file_text(&bridge_pid_file).await?;
    let marker_pid = wait_for_file_text(&pid_path).await?;
    assert_eq!(
        marker_pid, bridge_pid,
        "pid marker records bridge child pid"
    );
    let child_pid = parse_pid(&marker_pid)?;

    write_empty_state(&state_file)?;
    wait_for_path_absent(&pid_path).await?;
    wait_for_pid_dead(child_pid).await?;

    daemon.stop();
    Ok(())
}

#[tokio::test]
async fn pi_subscriber_restarts_after_bridge_exit() -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let state_file = temp.path().join("flightdeck-state-s505.json");
    write_state(&state_file, "issue")?;
    let count_file = temp.path().join("bridge-count");
    let bridge = write_fake_bridge(
        temp.path(),
        r#"
if [[ "$1" == "stream" ]]; then
  count_file="${FD_FAKE_COUNT:?}"
  count=0
  if [[ -f "$count_file" ]]; then count=$(cat "$count_file"); fi
  count=$((count + 1))
  printf '%s\n' "$count" > "$count_file"
  echo '{"type":"bridge_hello"}'
  exit 1
fi
exit 0
"#,
    )?;

    let mut daemon = spawn_daemon(
        temp.path(),
        &state_file,
        &bridge,
        &[("FD_FAKE_COUNT", count_file.as_path())],
    )
    .await?;

    wait_for_count(&count_file, 2).await?;
    daemon.stop();
    Ok(())
}

#[tokio::test]
async fn stop_after_wedge_kills_subscribers() -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let state_file = temp.path().join("flightdeck-state-s505.json");
    write_state(&state_file, "issue")?;
    let bridge_pid_file = temp.path().join("bridge-child-pid");
    let bridge = write_fake_bridge(
        temp.path(),
        r#"
if [[ "$1" == "stream" ]]; then
  printf '%s\n' "$$" > "${FD_FAKE_CHILD_PID:?}"
  while true; do sleep 1; done
fi
exit 0
"#,
    )?;

    let mut daemon = spawn_daemon(
        temp.path(),
        &state_file,
        &bridge,
        &[
            ("FD_FAKE_CHILD_PID", bridge_pid_file.as_path()),
            ("FLIGHTDECK_DASHBOARD_TEST_WEDGE_SIGNALS", temp.path()),
        ],
    )
    .await?;
    let bridge_pid = parse_pid(&wait_for_file_text(&bridge_pid_file).await?)?;
    let _marker_pid = wait_for_file_text(&subscriber_pid_path(temp.path())).await?;

    daemon.stop_with_env(&[("FLIGHTDECK_DASHBOARD_STOP_GRACE_MS", "100")]);
    wait_for_pid_dead(bridge_pid).await?;
    Ok(())
}
