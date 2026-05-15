use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::time::Instant;

use regex::Regex;

use chrono::{DateTime, Utc};

use crate::app::command::SnapshotSource;
use crate::app::motion::{EffectInstance, MotionLevel};
use crate::app::reload::ReloadCoalescer;
use crate::state::snapshot::{
    DashboardSnapshot, Event, EventImportance, SessionKind, TrackedSession,
};

pub type Clock = fn() -> DateTime<Utc>;

pub const RECENT_EVENTS_CAP: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Tab {
    Overview,
    LiveFeed,
    Conversations,
    Merges,
    Decisions,
    Daemon,
}

impl Tab {
    pub const ALL: [Self; 6] = [
        Self::Overview,
        Self::LiveFeed,
        Self::Conversations,
        Self::Merges,
        Self::Decisions,
        Self::Daemon,
    ];

    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Overview => "Overview",
            Self::LiveFeed => "Live feed",
            Self::Conversations => "Conversations",
            Self::Merges => "Conflicts & merges",
            Self::Decisions => "Decisions",
            Self::Daemon => "Daemon",
        }
    }

    #[must_use]
    pub const fn issue_mode_label(self) -> &'static str {
        match self {
            Self::Merges => "Conflicts & merges (issue mode)",
            _ => self.label(),
        }
    }

    #[must_use]
    pub fn index(self) -> usize {
        Self::ALL.iter().position(|tab| *tab == self).unwrap_or(0)
    }

    #[must_use]
    pub fn next(self) -> Self {
        let idx = self.index();
        Self::ALL[(idx + 1) % Self::ALL.len()]
    }

    #[must_use]
    pub fn previous(self) -> Self {
        let idx = self.index();
        let len = Self::ALL.len();
        Self::ALL[(idx + len - 1) % len]
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UiFlags {
    pub compact: bool,
    pub filter_open: bool,
    pub show_noisy: bool,
}

#[derive(Debug, Clone)]
pub struct FeedFilter {
    pub input: String,
    pub pattern: String,
    pub regex: Option<Regex>,
    pub error: Option<String>,
}

impl FeedFilter {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            input: String::new(),
            pattern: String::new(),
            regex: None,
            error: None,
        }
    }

    pub fn begin_edit(&mut self) {
        self.input.clone_from(&self.pattern);
        self.error = None;
    }

    pub fn clear(&mut self) {
        self.input.clear();
        self.pattern.clear();
        self.regex = None;
        self.error = None;
    }

    pub fn commit(&mut self) -> bool {
        if self.input.trim().is_empty() {
            self.clear();
            return true;
        }
        match Regex::new(&self.input) {
            Ok(regex) => {
                self.pattern.clone_from(&self.input);
                self.regex = Some(regex);
                self.error = None;
                true
            }
            Err(error) => {
                self.error = Some(error.to_string());
                false
            }
        }
    }

    #[must_use]
    pub fn matches(&self, event: &Event) -> bool {
        self.regex.as_ref().map_or(true, |regex| {
            regex.is_match(&event.message) || regex.is_match(event.source.as_chip())
        })
    }
}

impl Default for FeedFilter {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadSourceState {
    Live,
    Archive { archived_at: DateTime<Utc> },
    Missing,
}

impl ReadSourceState {
    #[must_use]
    pub fn from_snapshot(snapshot: &DashboardSnapshot) -> Self {
        if is_archive_path(&snapshot.master_state_path) {
            return Self::Archive {
                archived_at: snapshot.terminated_at.unwrap_or(snapshot.updated_at),
            };
        }
        Self::Live
    }
}

fn is_archive_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".json.archive"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModalState {
    None,
    Help,
    DecisionDetail,
}

#[derive(Debug)]
pub struct Model {
    pub current_tab: Tab,
    pub tabs_enabled: Vec<Tab>,
    pub snapshot: DashboardSnapshot,
    pub snapshot_source: SnapshotSource,
    pub read_source_state: ReadSourceState,
    pub recent_events: VecDeque<Event>,
    pub snapshot_diff_drops: u64,
    pub reload_coalescer: ReloadCoalescer,
    pub now: DateTime<Utc>,
    pub motion: MotionLevel,
    pub motion_clock: Instant,
    pub active_effects: Vec<EffectInstance>,
    pub selection: HashMap<Tab, usize>,
    pub show_help: bool,
    pub modal: ModalState,
    pub ui: UiFlags,
    pub feed_filter: FeedFilter,
    pub current_pane_id: Option<String>,
    pub quit_requested: bool,
    pub error: Option<String>,
    pub clock: Clock,
    pub animate_frame: u64,
}

impl Model {
    #[must_use]
    pub fn new(
        snapshot: DashboardSnapshot,
        snapshot_source: SnapshotSource,
        motion: MotionLevel,
        clock: Clock,
    ) -> Self {
        let tabs_enabled = enabled_tabs_for(&snapshot);
        let mut selection = HashMap::with_capacity(Tab::ALL.len());
        for tab in Tab::ALL {
            selection.insert(tab, 0);
        }
        let read_source_state = ReadSourceState::from_snapshot(&snapshot);
        let recent_events = snapshot.recent_events.clone();
        Self {
            current_tab: Tab::Overview,
            tabs_enabled,
            snapshot,
            snapshot_source,
            read_source_state,
            recent_events,
            snapshot_diff_drops: 0,
            reload_coalescer: ReloadCoalescer::new(),
            now: clock(),
            motion,
            motion_clock: Instant::now(),
            active_effects: Vec::with_capacity(8),
            selection,
            show_help: false,
            modal: ModalState::None,
            ui: UiFlags {
                compact: false,
                filter_open: false,
                show_noisy: true,
            },
            feed_filter: FeedFilter::new(),
            current_pane_id: std::env::var("TMUX_PANE")
                .ok()
                .filter(|pane| !pane.is_empty()),
            quit_requested: false,
            error: None,
            clock,
            animate_frame: 0,
        }
    }

    pub fn refresh_now(&mut self) {
        self.now = (self.clock)();
    }

    #[must_use]
    pub fn selected_index(&self) -> usize {
        self.selection
            .get(&self.current_tab)
            .copied()
            .unwrap_or_default()
    }

    pub fn set_selected_index(&mut self, value: usize) {
        let max = self.max_selection_index();
        self.selection.insert(self.current_tab, value.min(max));
    }

    #[must_use]
    pub fn selected_session(&self) -> Option<&TrackedSession> {
        self.snapshot.sessions.get(self.selected_index())
    }

    #[must_use]
    pub fn max_selection_index(&self) -> usize {
        let len = match self.current_tab {
            Tab::Overview => self.snapshot.sessions.len(),
            Tab::LiveFeed => self.filtered_events().len(),
            Tab::Conversations => self.snapshot.conversations.len(),
            Tab::Merges => self
                .snapshot
                .merge_queue
                .len()
                .saturating_add(self.snapshot.conflict_graph.edges.len()),
            Tab::Decisions => self.decision_count(),
            Tab::Daemon => 1,
        };
        len.saturating_sub(1)
    }

    pub fn clamp_selection(&mut self) {
        if !self.tabs_enabled.contains(&self.current_tab) {
            self.current_tab = self.tabs_enabled.first().copied().unwrap_or(Tab::Overview);
        }
        let current = self.selected_index();
        self.set_selected_index(current);
    }

    pub fn refresh_tabs_enabled(&mut self) {
        self.tabs_enabled = enabled_tabs_for(&self.snapshot);
        self.clamp_selection();
    }

    #[must_use]
    pub fn selected_tab_position(&self) -> usize {
        self.tabs_enabled
            .iter()
            .position(|tab| *tab == self.current_tab)
            .unwrap_or_default()
    }

    #[must_use]
    pub fn tab_label(&self, tab: Tab) -> &'static str {
        if tab == Tab::Merges && self.has_issue_sessions() {
            return tab.issue_mode_label();
        }
        tab.label()
    }

    #[must_use]
    pub fn next_tab(&self) -> Tab {
        let current = self.selected_tab_position();
        self.tabs_enabled
            .get((current + 1) % self.tabs_enabled.len().max(1))
            .copied()
            .unwrap_or(Tab::Overview)
    }

    #[must_use]
    pub fn previous_tab(&self) -> Tab {
        let len = self.tabs_enabled.len();
        if len == 0 {
            return Tab::Overview;
        }
        let current = self.selected_tab_position();
        self.tabs_enabled[(current + len - 1) % len]
    }

    #[must_use]
    pub fn has_issue_sessions(&self) -> bool {
        self.snapshot
            .sessions
            .iter()
            .any(|session| session.kind == SessionKind::Issue)
    }

    #[must_use]
    pub fn decision_count(&self) -> usize {
        self.snapshot
            .sessions
            .iter()
            .map(|session| session.decisions_log.len())
            .sum()
    }

    #[must_use]
    pub fn is_observer(&self) -> bool {
        let Some(current) = self.current_pane_id.as_deref() else {
            return false;
        };
        let Some(owner) = &self.snapshot.owner else {
            return false;
        };
        owner
            .pane_id
            .as_deref()
            .is_some_and(|owner_pane| owner_pane != current)
    }

    pub fn push_event(&mut self, event: Event) {
        if self.recent_events.len() >= RECENT_EVENTS_CAP {
            self.recent_events.pop_front();
        }
        self.recent_events.push_back(event);
    }

    #[must_use]
    pub fn filtered_events(&self) -> Vec<&Event> {
        self.recent_events
            .iter()
            .rev()
            .filter(|event| self.ui.show_noisy || event.importance >= EventImportance::Important)
            .filter(|event| self.feed_filter.matches(event))
            .collect()
    }
}

fn enabled_tabs_for(snapshot: &DashboardSnapshot) -> Vec<Tab> {
    Tab::ALL
        .into_iter()
        .filter(|tab| {
            *tab != Tab::Merges
                || snapshot
                    .sessions
                    .iter()
                    .any(|session| session.kind == SessionKind::Issue)
        })
        .collect()
}

pub fn utc_now() -> DateTime<Utc> {
    Utc::now()
}
