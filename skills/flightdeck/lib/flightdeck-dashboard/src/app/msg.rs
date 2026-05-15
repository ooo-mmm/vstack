use crossterm::event::KeyEvent;

use crate::app::model::ReadSourceState;
use crate::daemon::rpc::DaemonStatus as RuntimeDaemonStatus;
use crate::state::snapshot::{DashboardSnapshot, Event};
use crate::watcher::WatcherEvent;

#[derive(Debug)]
pub enum Msg {
    Tick,
    AnimateTick,
    KeyPressed(KeyEvent),
    Resize(u16, u16),
    SnapshotUpdated {
        snapshot: Box<DashboardSnapshot>,
        source_state: ReadSourceState,
    },
    EventReceived(Event),
    WatcherEvent(WatcherEvent),
    DaemonStatus(RuntimeDaemonStatus),
    Error(String),
    Quit,
}
