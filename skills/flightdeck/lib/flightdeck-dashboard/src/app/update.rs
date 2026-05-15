use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use crate::daemon::rpc::DaemonStatus as RuntimeDaemonStatus;
use crate::state::snapshot::{DaemonStatus as SnapshotDaemonStatus, EventImportance};
use crate::watcher::WatcherEvent;

use super::command::Cmd;
use super::keymap::{self, Action};
use super::model::{ModalState, Model};
use super::motion::{self, EffectKind, EffectTarget};
use super::msg::Msg;

const PAGE_STEP: usize = 10;

pub fn update(model: &mut Model, msg: Msg) -> Vec<Cmd> {
    match msg {
        Msg::Tick => {
            model.refresh_now();
            vec![Cmd::Render]
        }
        Msg::AnimateTick => {
            model.animate_frame = model.animate_frame.saturating_add(1);
            motion::prune_effects(&mut model.active_effects, model.animate_frame);
            vec![Cmd::Render]
        }
        Msg::KeyPressed(key) => handle_key(model, &key),
        Msg::Resize(_, _) => vec![Cmd::Render],
        Msg::SnapshotUpdated {
            snapshot,
            source_state,
        } => handle_snapshot_updated(model, *snapshot, source_state),
        Msg::EventReceived(event) => {
            let important = event.importance >= EventImportance::Important;
            model.push_event(event);
            push_effect(model, EffectKind::ActivityRowEnter, EffectTarget::Row(0));
            if important {
                push_effect(
                    model,
                    EffectKind::ActivityImportantFlash,
                    EffectTarget::Row(0),
                );
            }
            vec![Cmd::Render]
        }
        Msg::WatcherEvent(WatcherEvent::Reload) => request_reload(model),
        Msg::DaemonStatus(status) => {
            model.snapshot.daemon = daemon_status_chip(&status);
            vec![Cmd::Render]
        }
        Msg::Error(error) => {
            model.error = Some(error);
            push_effect(model, EffectKind::ErrorFlash, EffectTarget::Global);
            finish_reload(model, true)
        }
        Msg::Quit => {
            model.quit_requested = true;
            vec![Cmd::Render]
        }
    }
}

fn handle_snapshot_updated(
    model: &mut Model,
    snapshot: crate::state::snapshot::DashboardSnapshot,
    source_state: super::model::ReadSourceState,
) -> Vec<Cmd> {
    let pending_reload = finish_reload(model, false);
    if model.snapshot.structural_eq(&snapshot) && model.read_source_state == source_state {
        model.snapshot_diff_drops = model.snapshot_diff_drops.saturating_add(1);
        return pending_reload;
    }
    model.snapshot = snapshot;
    model.read_source_state = source_state;
    model.refresh_now();
    model.clamp_selection();
    let mut commands = vec![Cmd::Render];
    commands.extend(pending_reload);
    commands
}

fn finish_reload(model: &mut Model, render: bool) -> Vec<Cmd> {
    let mut commands = Vec::new();
    if model.reload_coalescer.finish() {
        commands.push(Cmd::ReloadFromSource(model.snapshot_source.clone()));
    }
    if render {
        commands.push(Cmd::Render);
    }
    commands
}

fn request_reload(model: &mut Model) -> Vec<Cmd> {
    if model.reload_coalescer.request() {
        vec![Cmd::ReloadFromSource(model.snapshot_source.clone())]
    } else {
        Vec::new()
    }
}

fn handle_key(model: &mut Model, key: &KeyEvent) -> Vec<Cmd> {
    if model.ui.filter_open {
        return handle_filter_key(model, key);
    }

    let Some(action) = keymap::action_for(key) else {
        return Vec::new();
    };

    if model.show_help
        && !matches!(
            action,
            Action::ToggleHelp | Action::Quit | Action::CloseModal
        )
    {
        return Vec::new();
    }

    match action {
        Action::NextTab => {
            model.current_tab = model.current_tab.next();
            let target = EffectTarget::Tab(model.current_tab.index());
            push_effect(model, EffectKind::TabSwitchForward, target);
            vec![Cmd::Render]
        }
        Action::PreviousTab => {
            model.current_tab = model.current_tab.previous();
            let target = EffectTarget::Tab(model.current_tab.index());
            push_effect(model, EffectKind::TabSwitchBackward, target);
            vec![Cmd::Render]
        }
        Action::MoveDown => {
            move_selection(model, 1);
            vec![Cmd::Render]
        }
        Action::MoveUp => {
            move_selection(model, -1);
            vec![Cmd::Render]
        }
        Action::PageDown => {
            move_selection(model, PAGE_STEP as isize);
            vec![Cmd::Render]
        }
        Action::PageUp => {
            move_selection(model, -(PAGE_STEP as isize));
            vec![Cmd::Render]
        }
        Action::First => {
            model.set_selected_index(0);
            let target = EffectTarget::Row(model.selected_index());
            push_effect(model, EffectKind::SelectionHalo, target);
            vec![Cmd::Render]
        }
        Action::Last => {
            model.set_selected_index(model.max_selection_index());
            let target = EffectTarget::Row(model.selected_index());
            push_effect(model, EffectKind::SelectionHalo, target);
            vec![Cmd::Render]
        }
        Action::OpenDetail => vec![Cmd::LogAction(format!(
            "detail requested for tab={} row={}",
            model.current_tab.label(),
            model.selected_index()
        ))],
        Action::OpenFilter => {
            model.feed_filter.begin_edit();
            model.ui.filter_open = true;
            vec![
                Cmd::LogAction(String::from("filter input opened")),
                Cmd::Render,
            ]
        }
        Action::Reload => request_reload(model),
        Action::ToggleNoise => {
            model.ui.show_noisy = !model.ui.show_noisy;
            vec![Cmd::Render]
        }
        Action::ToggleCompact => {
            model.ui.compact = !model.ui.compact;
            vec![Cmd::Render]
        }
        Action::ToggleHelp => {
            model.show_help = !model.show_help;
            model.modal = if model.show_help {
                ModalState::Help
            } else {
                ModalState::None
            };
            push_effect(model, EffectKind::HelpOverlay, EffectTarget::Global);
            vec![Cmd::Render]
        }
        Action::Quit => {
            model.quit_requested = true;
            vec![Cmd::Render]
        }
        Action::CloseModal => {
            model.show_help = false;
            model.modal = ModalState::None;
            model.ui.filter_open = false;
            vec![Cmd::Render]
        }
    }
}

fn handle_filter_key(model: &mut Model, key: &KeyEvent) -> Vec<Cmd> {
    match key.code {
        KeyCode::Enter => {
            if model.feed_filter.commit() {
                model.ui.filter_open = false;
            }
            vec![Cmd::Render]
        }
        KeyCode::Esc => {
            model.ui.filter_open = false;
            model.feed_filter.error = None;
            vec![Cmd::Render]
        }
        KeyCode::Backspace => {
            model.feed_filter.input.pop();
            model.feed_filter.error = None;
            vec![Cmd::Render]
        }
        KeyCode::Char('n') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            model.ui.show_noisy = !model.ui.show_noisy;
            vec![Cmd::Render]
        }
        KeyCode::Char(ch) if key.modifiers.is_empty() || key.modifiers == KeyModifiers::SHIFT => {
            model.feed_filter.input.push(ch);
            model.feed_filter.error = None;
            vec![Cmd::Render]
        }
        _ => Vec::new(),
    }
}

fn move_selection(model: &mut Model, delta: isize) {
    let current = model.selected_index();
    let next = current
        .saturating_add_signed(delta)
        .min(model.max_selection_index());
    model.set_selected_index(next);
    let target = EffectTarget::Row(model.selected_index());
    push_effect(model, EffectKind::SelectionHalo, target);
}

fn daemon_status_chip(status: &RuntimeDaemonStatus) -> SnapshotDaemonStatus {
    let label = if status.running {
        status.pid.map_or_else(
            || String::from("daemon: rust"),
            |pid| format!("daemon: rust pid={pid}"),
        )
    } else {
        String::from("daemon: stopped")
    };
    SnapshotDaemonStatus {
        label,
        healthy: Some(status.running),
        pid: status.pid,
        last_heartbeat_at: status.last_change_at,
    }
}

fn push_effect(model: &mut Model, kind: EffectKind, target: EffectTarget) {
    motion::push_effect(
        &mut model.active_effects,
        model.motion,
        model.animate_frame,
        kind,
        target,
    );
}
