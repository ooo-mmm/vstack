mod common;

use std::fs;
use std::path::PathBuf;

use flightdeck_dashboard::app::command::SnapshotSource;
use flightdeck_dashboard::app::model::{Model, ReadSourceState, Tab};
use flightdeck_dashboard::app::motion::{self, MotionLevel};
use flightdeck_dashboard::state::snapshot::{DashboardSnapshot, PauseInfo, SessionState};
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
fn pause_banner_at_top_and_right_rail_only_on_paused_row() {
    let mut model = common::model_for_fixture("mixed", MotionLevel::Off);
    model.snapshot.paused_for_user = Some(PauseInfo {
        entry_id: Some("VST-101".to_owned()),
        issue_id: Some("VST-101".to_owned()),
        reason: "scope_creep_detected".to_owned(),
        prompt_text: Some("scope_files_actual=23 > 2x declared=8".to_owned()),
    });
    let paused_index = model
        .snapshot
        .sessions
        .iter()
        .position(|session| session.id == "VST-101")
        .expect("paused fixture row exists");
    model.set_selected_index(paused_index);
    let paused_render = common::render_model(&model);
    let top_region = paused_render.lines().take(5).collect::<Vec<_>>().join("\n");
    assert!(top_region.contains("PAUSED FOR USER · VST-101 · scope_creep_detected"));
    assert_eq!(paused_render.matches("PAUSED FOR USER").count(), 2);

    let other_index = model
        .snapshot
        .sessions
        .iter()
        .position(|session| session.id != "VST-101")
        .expect("non-paused fixture row exists");
    model.set_selected_index(other_index);
    let other_render = common::render_model(&model);
    assert_eq!(other_render.matches("PAUSED FOR USER").count(), 1);
    insta::assert_snapshot!("overview_pause_banner_scoped_right_rail", paused_render);
}

#[test]
fn default_selects_paused_then_prompting_then_first() {
    let mut paused_snapshot =
        flightdeck_dashboard::fixtures::load_demo_snapshot("mixed", common::fixed_now())
            .expect("fixture loads");
    paused_snapshot.paused_for_user = Some(PauseInfo {
        entry_id: Some("dashboard-rust".to_owned()),
        issue_id: None,
        reason: "operator-question".to_owned(),
        prompt_text: Some("Need direction".to_owned()),
    });
    let paused_model = Model::new(
        paused_snapshot,
        SnapshotSource::Demo("mixed"),
        MotionLevel::Off,
        common::fixed_now,
    );
    assert_eq!(
        paused_model
            .selected_session()
            .map(|session| session.id.as_str()),
        Some("dashboard-rust")
    );

    let prompting_model = common::model_for_fixture("mixed", MotionLevel::Off);
    assert_eq!(
        prompting_model
            .selected_session()
            .map(|session| session.id.as_str()),
        Some("VST-101")
    );

    let mut first_snapshot =
        flightdeck_dashboard::fixtures::load_demo_snapshot("mixed", common::fixed_now())
            .expect("fixture loads");
    for session in &mut first_snapshot.sessions {
        session.state = SessionState::Dead;
    }
    let first_model = Model::new(
        first_snapshot,
        SnapshotSource::Demo("mixed"),
        MotionLevel::Off,
        common::fixed_now,
    );
    assert_eq!(
        first_model
            .selected_session()
            .map(|session| session.id.as_str()),
        Some("VST-101")
    );
}

#[test]
fn header_counts_fit_at_140_cols() {
    let rendered = common::render_model_with_size(
        &common::model_for_fixture("mixed", MotionLevel::Off),
        140,
        common::SNAPSHOT_HEIGHT,
    );
    assert!(rendered.contains("P:1"));
    assert!(rendered.contains("S:1"));
    assert!(rendered.contains("W:1"));
    assert!(!rendered.contains("prompting:"));
    insta::assert_snapshot!("overview_header_counts_140_cols", rendered);
}

#[test]
fn observer_banner() {
    let mut model = common::model_for_fixture("observer", MotionLevel::Off);
    model.current_pane_id = Some("%99".to_owned());
    let rendered = common::render_model(&model);
    assert!(rendered.contains("observer"));
    assert!(!rendered.contains("Read-only observer"));
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
fn compact_tree_dashboard_widget() {
    let mut model = common::model_for_fixture("mixed", MotionLevel::Off);
    let workflow = model
        .snapshot
        .sessions
        .iter_mut()
        .find(|session| session.id == "dashboard-rust")
        .expect("workflow row exists");
    workflow.id = "flightdeck-dashboard".to_owned();
    workflow.state = SessionState::Ready;
    workflow.title = "Flightdeck Dashboard".to_owned();
    model.ui.compact = true;
    let rendered = common::render_model(&model);
    assert!(rendered.contains("› VST-101"));
    assert!(rendered.contains("flightdeck-dashboard  ready"));
    assert!(!rendered.contains("flightdeck-dashboardready"));
    insta::assert_snapshot!("overview_compact_tree_dashboard_widget", rendered);
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
