use std::time::{Duration, Instant};

use flightdeck_dashboard::watcher::{StateWatcher, WatcherEvent};
use tokio::sync::mpsc;

fn wait_for_reload(rx: &mut mpsc::UnboundedReceiver<WatcherEvent>) -> bool {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(2) {
        match rx.try_recv() {
            Ok(WatcherEvent::Reload) => return true,
            Err(mpsc::error::TryRecvError::Empty) => std::thread::sleep(Duration::from_millis(25)),
            Err(mpsc::error::TryRecvError::Disconnected) => return false,
        }
    }
    false
}

#[test]
fn rapid_edits_are_debounced() {
    let dir = tempfile::tempdir().expect("tempdir creates");
    let live = dir.path().join("flightdeck-state-HT.json");
    std::fs::write(&live, "{}").expect("state writes");
    let (tx, mut rx) = mpsc::unbounded_channel();
    let _watcher = StateWatcher::spawn(
        live.clone(),
        dir.path().to_path_buf(),
        tx,
        Duration::from_millis(100),
    )
    .expect("watcher starts");

    for idx in 0..10 {
        std::fs::write(&live, format!("{{\"idx\":{idx}}}")).expect("state mutates");
    }

    let start = Instant::now();
    let mut reloads = 0usize;
    while start.elapsed() < Duration::from_secs(2) {
        match rx.try_recv() {
            Ok(WatcherEvent::Reload) => reloads += 1,
            Err(mpsc::error::TryRecvError::Empty) => std::thread::sleep(Duration::from_millis(25)),
            Err(mpsc::error::TryRecvError::Disconnected) => break,
        }
        if reloads >= 3 {
            break;
        }
    }

    assert!(reloads > 0, "watcher should emit at least one reload");
    assert!(
        reloads < 10,
        "debounce should coalesce rapid writes: {reloads}"
    );
}

#[test]
fn activity_sidecar_changes_emit_reload() {
    let dir = tempfile::tempdir().expect("tempdir creates");
    let live = dir.path().join("flightdeck-state-HT.json");
    std::fs::write(&live, "{}").expect("state writes");
    let (tx, mut rx) = mpsc::unbounded_channel();
    let _watcher = StateWatcher::spawn(
        live,
        dir.path().to_path_buf(),
        tx,
        Duration::from_millis(50),
    )
    .expect("watcher starts");

    std::fs::write(dir.path().join("flightdeck-activity-HT.jsonl"), "{}\n")
        .expect("activity writes");
    assert!(
        wait_for_reload(&mut rx),
        "live activity sidecar should reload"
    );

    std::fs::write(
        dir.path()
            .join("flightdeck-activity-HT-2026-05-15T100000Z.jsonl.archive"),
        "{}\n",
    )
    .expect("activity archive writes");
    assert!(wait_for_reload(&mut rx), "activity archive should reload");
}
