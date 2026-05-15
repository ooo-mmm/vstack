mod common;

use flightdeck_dashboard::app::model::{ModalState, Tab};
use flightdeck_dashboard::app::motion::{self, EffectKind, EffectTarget, MotionLevel};
use flightdeck_dashboard::state::snapshot::{ActivitySource, Event, EventImportance};

#[test]
fn mixed_overview_tab() {
    insta::assert_snapshot!(
        "tab_overview",
        common::render_model(&common::model_for_tab(Tab::Overview))
    );
}

#[test]
fn mixed_live_feed_tab() {
    insta::assert_snapshot!(
        "tab_live_feed",
        common::render_model(&common::model_for_tab(Tab::LiveFeed))
    );
}

#[test]
fn live_feed_with_events() {
    let mut model = common::model_for_tab(Tab::LiveFeed);
    seed_events(&mut model);
    insta::assert_snapshot!("tab_live_feed_with_events", common::render_model(&model));
}

#[test]
fn live_feed_row_enter_motion_start_and_settled() {
    let mut model = common::model_for_fixture("mixed", MotionLevel::Full);
    model.current_tab = Tab::LiveFeed;
    seed_events(&mut model);
    flightdeck_dashboard::app::motion::push_effect(
        &mut model.active_effects,
        model.motion,
        model.animate_frame,
        EffectKind::ActivityRowEnter,
        EffectTarget::Row(0),
    );
    flightdeck_dashboard::app::motion::push_effect(
        &mut model.active_effects,
        model.motion,
        model.animate_frame,
        EffectKind::ActivityImportantFlash,
        EffectTarget::Row(0),
    );
    insta::assert_snapshot!("tab_live_feed_motion_t0", common::render_model(&model));
    model.animate_frame = 8;
    motion::prune_effects(&mut model.active_effects, model.animate_frame);
    insta::assert_snapshot!("tab_live_feed_motion_settled", common::render_model(&model));
}

#[test]
fn mixed_conversations_tab() {
    insta::assert_snapshot!(
        "tab_conversations",
        common::render_model(&common::model_for_tab(Tab::Conversations))
    );
}

#[test]
fn conversations_stream_newest_first() {
    let mut model = common::model_for_fixture("conversations", MotionLevel::Off);
    model.current_tab = Tab::Conversations;
    let rendered = common::render_model(&model);
    assert!(rendered.contains("newest first · pane ids hidden"));
    assert!(rendered.contains("assistant (stream)"));
    assert!(!rendered.contains("10:08:35"));
    insta::assert_snapshot!("tab_conversations_stream", rendered);
}

#[test]
fn mixed_merges_tab() {
    insta::assert_snapshot!(
        "tab_merges",
        common::render_model(&common::model_for_tab(Tab::Merges))
    );
}

#[test]
fn merges_tab_hidden_without_issue_rows() {
    let model = common::model_for_fixture("no-issue", MotionLevel::Off);
    let rendered = common::render_model(&model);
    assert!(!model.tabs_enabled.contains(&Tab::Merges));
    assert!(!rendered.contains("Conflicts & merges"));
    insta::assert_snapshot!("tab_merges_hidden_without_issue_rows", rendered);
}

#[test]
fn mixed_decisions_tab() {
    insta::assert_snapshot!(
        "tab_decisions",
        common::render_model(&common::model_for_tab(Tab::Decisions))
    );
}

#[test]
fn decisions_detail_popup() {
    let mut model = common::model_for_fixture("decisions", MotionLevel::Off);
    model.current_tab = Tab::Decisions;
    model.modal = ModalState::DecisionDetail;
    insta::assert_snapshot!("tab_decisions_detail_popup", common::render_model(&model));
}

#[test]
fn mixed_daemon_tab() {
    let mut model = common::model_for_tab(Tab::Daemon);
    model.snapshot.daemon = flightdeck_dashboard::state::snapshot::DaemonStatus {
        label: "daemon: rust pid=4242".to_owned(),
        healthy: Some(true),
        pid: Some(4242),
        last_heartbeat_at: Some(common::fixed_now() - chrono::Duration::seconds(8)),
    };
    seed_events(&mut model);
    insta::assert_snapshot!("tab_daemon", common::render_model(&model));
}

fn seed_events(model: &mut flightdeck_dashboard::app::model::Model) {
    let base = common::fixed_now();
    let rows = [
        (
            ActivitySource::Daemon,
            EventImportance::Low,
            "daemon heartbeat folded",
        ),
        (
            ActivitySource::Wake,
            EventImportance::Medium,
            "wake delivered to master",
        ),
        (
            ActivitySource::Prompt,
            EventImportance::Important,
            "prompt detected: merge-now",
        ),
        (
            ActivitySource::State,
            EventImportance::Medium,
            "ISS-7 state changed ready → prompting",
        ),
        (
            ActivitySource::Decision,
            EventImportance::Important,
            "decision recorded: YES",
        ),
        (
            ActivitySource::Error,
            EventImportance::Important,
            "adapter timeout recovered",
        ),
    ];
    for (idx, (source, importance, message)) in rows.into_iter().enumerate() {
        model.push_event(Event::new(
            base - chrono::Duration::seconds(idx as i64),
            source,
            importance,
            message,
        ));
    }
}

#[test]
fn help_overlay() {
    let mut model = common::model_for_tab(Tab::Overview);
    model.show_help = true;
    model.modal = ModalState::Help;
    insta::assert_snapshot!("help_overlay", common::render_model(&model));
}
