mod common;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use flightdeck_dashboard::actions::{focus_args, pane_registry_args, WriteAction};
use flightdeck_dashboard::app::command::Cmd;
use flightdeck_dashboard::app::model::ModalState;
use flightdeck_dashboard::app::msg::Msg;
use flightdeck_dashboard::app::update;
use flightdeck_dashboard::tmux::panes::{parse_panes, PaneSnapshot};

#[test]
fn prune_stale_entry_builds_registry_remove_args() {
    assert_eq!(pane_registry_args("HT-9000"), ["remove", "HT-9000"]);
}

#[test]
fn focus_window_builds_tmux_select_args() {
    assert_eq!(focus_args("VS:3.1"), ["select-window", "-t", "VS:3.1"]);
}

#[test]
fn cancel_does_nothing() {
    let mut model =
        common::model_for_fixture("mixed", flightdeck_dashboard::app::motion::MotionLevel::Off);
    model.confirm = Some(flightdeck_dashboard::app::model::ConfirmDialog {
        title: String::from("Focus this session?"),
        body: String::from("body"),
        destructive: false,
        primary_label: String::from("Focus"),
        secondary_label: String::from("Cancel"),
        action: WriteAction::FocusWindow {
            pane_target: String::from("demo:3.0"),
        },
    });
    model.modal = ModalState::ConfirmAction;

    let commands = update(&mut model, Msg::KeyPressed(key(KeyCode::Esc)));

    assert!(model.confirm.is_none());
    assert_eq!(model.modal, ModalState::None);
    assert!(commands
        .iter()
        .all(|command| matches!(command, Cmd::Render)));
}

#[test]
fn stale_detection_requires_absent_live_pane() {
    let mut model =
        common::model_for_fixture("mixed", flightdeck_dashboard::app::motion::MotionLevel::Off);
    let session = model
        .snapshot
        .sessions
        .first()
        .expect("fixture row")
        .clone();
    model.tmux_panes = PaneSnapshot::default();
    assert!(!model.session_is_stale(&session));

    model.tmux_panes = parse_panes("%41\n%51\n%31\n");
    assert!(!model.session_is_stale(&session));

    model.tmux_panes = parse_panes("%51\n%31\n");
    assert!(model.session_is_stale(&session));
}

#[test]
fn delete_on_stale_row_opens_prune_confirm() {
    let mut model =
        common::model_for_fixture("mixed", flightdeck_dashboard::app::motion::MotionLevel::Off);
    let selected_pane = model
        .selected_session()
        .and_then(|session| session.pane_id.clone())
        .expect("selected row has pane");
    model.tmux_panes = parse_panes("%31\n%51\n");
    assert!(!model.tmux_panes.contains(&selected_pane));

    let commands = update(&mut model, Msg::KeyPressed(key(KeyCode::Char('D'))));

    assert_eq!(model.modal, ModalState::ConfirmAction);
    let confirm = model.confirm.as_ref().expect("confirm dialog set");
    assert!(confirm.destructive);
    assert_eq!(confirm.primary_label, "Prune");
    assert!(matches!(
        confirm.action,
        WriteAction::PruneStaleEntry { ref entry_id } if entry_id == "VST-101"
    ));
    assert!(commands
        .iter()
        .any(|command| matches!(command, Cmd::Render)));
}

#[test]
fn go_on_selected_row_opens_focus_confirm() {
    let mut model =
        common::model_for_fixture("mixed", flightdeck_dashboard::app::motion::MotionLevel::Off);

    let commands = update(&mut model, Msg::KeyPressed(key(KeyCode::Char('g'))));

    assert_eq!(model.modal, ModalState::ConfirmAction);
    let confirm = model.confirm.as_ref().expect("confirm dialog set");
    assert!(!confirm.destructive);
    assert_eq!(confirm.primary_label, "Focus");
    assert!(matches!(
        confirm.action,
        WriteAction::FocusWindow { ref pane_target } if pane_target == "demo:3.0"
    ));
    assert!(commands
        .iter()
        .any(|command| matches!(command, Cmd::Render)));
}

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::empty())
}
