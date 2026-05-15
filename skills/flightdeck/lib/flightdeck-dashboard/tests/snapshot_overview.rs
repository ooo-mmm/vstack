mod common;

use std::fs;
use std::path::PathBuf;

use flightdeck_dashboard::app::command::SnapshotSource;
use flightdeck_dashboard::app::model::{Model, ReadSourceState, Tab};
use flightdeck_dashboard::app::motion::{self, MotionLevel};
use flightdeck_dashboard::state::snapshot::DashboardSnapshot;
use flightdeck_dashboard::state::tracked_entries::{
    self, PRE_PURGE_BANNER, PRE_PURGE_STATE_MESSAGE,
};

fn render_fixture(name: &'static str) -> String {
    common::render_model(&common::model_for_fixture(name, MotionLevel::Off))
}

#[test]
fn empty_fixture_overview() {
    insta::assert_snapshot!("overview_empty", render_fixture("empty"));
}

#[test]
fn one_adhoc_fixture_overview() {
    insta::assert_snapshot!("overview_one_adhoc", render_fixture("one-adhoc"));
}

#[test]
fn one_issue_fixture_overview() {
    insta::assert_snapshot!("overview_one_issue", render_fixture("one-issue"));
}

#[test]
fn mixed_fixture_overview() {
    insta::assert_snapshot!("overview_mixed", render_fixture("mixed"));
}

#[test]
fn terminated_fixture_overview() {
    insta::assert_snapshot!("overview_terminated", render_fixture("terminated"));
}

#[test]
fn paused_fixture_overview() {
    insta::assert_snapshot!("overview_paused", render_fixture("paused"));
}

#[test]
fn observer_banner() {
    let mut model = common::model_for_fixture("observer", MotionLevel::Off);
    model.current_pane_id = Some("%99".to_owned());
    let rendered = common::render_model(&model);
    assert!(rendered.contains("OBSERVER"));
    assert!(rendered.contains("Read-only observer"));
    insta::assert_snapshot!("overview_observer_banner", rendered);
}

#[test]
fn compact_dashboard_widget() {
    let mut model = common::model_for_fixture("mixed", MotionLevel::Off);
    model.ui.compact = true;
    insta::assert_snapshot!(
        "overview_compact_dashboard_widget",
        common::render_model(&model)
    );
}

#[test]
fn stale_chip_warn() {
    let mut model = common::model_for_fixture("mixed", MotionLevel::Off);
    model.snapshot.updated_at = common::fixed_now() - chrono::Duration::seconds(90);
    insta::assert_snapshot!("overview_stale_chip_warn", common::render_model(&model));
}

#[test]
fn stale_chip_stale() {
    let mut model = common::model_for_fixture("mixed", MotionLevel::Off);
    model.snapshot.updated_at = common::fixed_now() - chrono::Duration::seconds(600);
    insta::assert_snapshot!("overview_stale_chip_stale", common::render_model(&model));
}

#[test]
fn archive_banner() {
    let mut model = common::model_for_fixture("terminated", MotionLevel::Off);
    model.snapshot.master_state_path =
        PathBuf::from("tmp/flightdeck-state-demo-terminated-20260515T100700Z.json.archive");
    model.read_source_state = ReadSourceState::Archive {
        archived_at: model
            .snapshot
            .terminated_at
            .expect("terminated fixture has ts"),
    };
    insta::assert_snapshot!("overview_archive_banner", common::render_model(&model));
}

#[test]
fn archive_fallback_from_dir() {
    let temp = tempfile::tempdir().expect("tempdir");
    let archive = temp
        .path()
        .join("flightdeck-state-demo-terminated-20260515T100730Z.json.archive");
    fs::write(
        &archive,
        flightdeck_dashboard::fixtures::fixture_source("terminated").expect("fixture source"),
    )
    .expect("write archive fixture");
    let snapshot = tracked_entries::read_archive_fallback(
        temp.path(),
        "demo-terminated",
        PathBuf::from("/repo/demo").as_path(),
        common::fixed_now(),
    )
    .expect("archive fallback loads");
    let mut model = Model::new(
        snapshot,
        SnapshotSource::File(temp.path().join("flightdeck-state-demo-terminated.json")),
        MotionLevel::Off,
        common::fixed_now,
    );
    model.current_pane_id = None;
    assert!(matches!(
        model.read_source_state,
        ReadSourceState::Archive { .. }
    ));
    insta::assert_snapshot!(
        "overview_archive_fallback_from_dir",
        common::render_model(&model)
    );
}

#[test]
fn pre_purge_banner() {
    let snapshot = DashboardSnapshot::empty_with_error(
        "HT",
        PathBuf::from("tmp/flightdeck-state-HT.json"),
        common::fixed_now(),
        PRE_PURGE_STATE_MESSAGE,
        true,
    );
    let model = Model::new(
        snapshot,
        SnapshotSource::File(PathBuf::from("tmp/flightdeck-state-HT.json")),
        MotionLevel::Off,
        common::fixed_now,
    );
    let rendered = common::render_model(&model);
    assert!(rendered.contains(PRE_PURGE_BANNER));
    insta::assert_snapshot!("overview_pre_purge_banner", rendered);
}

#[test]
fn motion_effects_overview_start_and_settled() {
    let mut model = common::model_for_fixture("mixed", MotionLevel::Full);
    model.current_tab = Tab::Overview;
    insta::assert_snapshot!("overview_motion_t0", common::render_model(&model));
    model.animate_frame = 8;
    motion::prune_effects(&mut model.active_effects, model.animate_frame);
    insta::assert_snapshot!("overview_motion_settled", common::render_model(&model));
}
