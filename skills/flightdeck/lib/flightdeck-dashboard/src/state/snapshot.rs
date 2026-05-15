use std::collections::{BTreeMap, VecDeque};
use std::fmt;
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer};

use super::schema::{
    AdapterMetadata, DecisionLogEntry, DomainBlock, LaunchInfo, MasterState, OwnerBlock,
    TrackedEntry, TrackedIssueDomain,
};

#[derive(Debug, Clone, Default, PartialEq, Eq, Hash)]
pub enum SessionKind {
    #[default]
    Adhoc,
    Issue,
    Workflow,
    Other(String),
}

impl SessionKind {
    #[must_use]
    pub fn from_label(value: &str) -> Self {
        match value {
            "adhoc" => Self::Adhoc,
            "issue" => Self::Issue,
            "workflow" => Self::Workflow,
            other => Self::Other(other.to_owned()),
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Adhoc => "adhoc",
            Self::Issue => "issue",
            Self::Workflow => "workflow",
            Self::Other(value) => value.as_str(),
        }
    }

    #[must_use]
    pub const fn badge(&self) -> &'static str {
        match self {
            Self::Adhoc => "AH",
            Self::Issue => "ISS",
            Self::Workflow => "WF",
            Self::Other(_) => "??",
        }
    }
}

impl<'de> Deserialize<'de> for SessionKind {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(Self::from_label(value.trim()))
    }
}

impl PartialOrd for SessionKind {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for SessionKind {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.as_str().cmp(other.as_str())
    }
}

impl fmt::Display for SessionKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.pad(self.as_str())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Hash)]
pub enum SessionState {
    #[default]
    Waiting,
    Prompting,
    Submitting,
    Ready,
    Complete,
    Cancelled,
    Dead,
    MergeReady,
    Merged,
    Aborted,
    Other(String),
}

impl SessionState {
    #[must_use]
    pub fn from_label(value: &str) -> Self {
        match value {
            "waiting" => Self::Waiting,
            "prompting" => Self::Prompting,
            "submitting" => Self::Submitting,
            "ready" => Self::Ready,
            "complete" => Self::Complete,
            "cancelled" => Self::Cancelled,
            "dead" => Self::Dead,
            "merge-ready" => Self::MergeReady,
            "merged" => Self::Merged,
            "aborted" => Self::Aborted,
            other => Self::Other(other.to_owned()),
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Waiting => "waiting",
            Self::Prompting => "prompting",
            Self::Submitting => "submitting",
            Self::Ready => "ready",
            Self::Complete => "complete",
            Self::Cancelled => "cancelled",
            Self::Dead => "dead",
            Self::MergeReady => "merge-ready",
            Self::Merged => "merged",
            Self::Aborted => "aborted",
            Self::Other(value) => value.as_str(),
        }
    }

    #[must_use]
    pub const fn is_transient(&self) -> bool {
        matches!(self, Self::Waiting | Self::Prompting | Self::Submitting)
    }
}

impl<'de> Deserialize<'de> for SessionState {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(Self::from_label(value.trim()))
    }
}

impl PartialOrd for SessionState {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for SessionState {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.as_str().cmp(other.as_str())
    }
}

impl fmt::Display for SessionState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.pad(self.as_str())
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ConflictGraph {
    #[serde(default)]
    pub edges: Vec<(String, String)>,
    pub computed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PauseInfo {
    pub entry_id: Option<String>,
    pub issue_id: Option<String>,
    pub reason: String,
    pub prompt_text: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DashboardSnapshot {
    pub session_id: String,
    pub project_root: PathBuf,
    pub started_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
    pub terminated: bool,
    pub terminated_at: Option<DateTime<Utc>>,
    pub master_state_path: PathBuf,
    pub master_archive_error: Option<String>,
    pub master_error: Option<String>,
    pub pre_purge_state: bool,
    pub owner: Option<OwnerBlock>,
    pub daemon: DaemonStatus,
    pub counts: KindCounts,
    pub sessions: Vec<TrackedSession>,
    pub merge_queue: Vec<String>,
    pub conflict_graph: ConflictGraph,
    pub paused_for_user: Option<PauseInfo>,
    pub recent_events: VecDeque<Event>,
    pub conversations: Vec<ConversationStream>,
    pub summary_path: Option<PathBuf>,
}

impl DashboardSnapshot {
    #[must_use]
    pub fn from_master_state(state: MasterState, now: DateTime<Utc>) -> Self {
        let mut sessions: Vec<TrackedSession> = state
            .entries
            .into_iter()
            .map(|(key, entry)| TrackedSession::from_entry(key, entry))
            .collect();
        sessions.sort_by(|left, right| left.id.cmp(&right.id));
        let counts = KindCounts::from_sessions(&sessions);
        Self {
            session_id: state.session_id,
            project_root: PathBuf::from("."),
            started_at: state.started_at,
            updated_at: state.updated_at.unwrap_or(now),
            terminated: state.terminated,
            terminated_at: state.terminated_at,
            master_state_path: PathBuf::from("<demo-fixture>"),
            master_archive_error: state.master_archive_error,
            master_error: None,
            pre_purge_state: false,
            owner: state.owner,
            daemon: DaemonStatus::unknown(),
            counts,
            sessions,
            merge_queue: state.merge_queue,
            conflict_graph: state.conflict_graph,
            paused_for_user: state.paused_for_user,
            recent_events: VecDeque::with_capacity(0),
            conversations: Vec::new(),
            summary_path: state.summary_path,
        }
    }

    #[must_use]
    pub fn empty_with_error(
        session_id: impl Into<String>,
        master_state_path: PathBuf,
        now: DateTime<Utc>,
        error: impl Into<String>,
        pre_purge_state: bool,
    ) -> Self {
        let error = error.into();
        Self {
            session_id: session_id.into(),
            project_root: PathBuf::from("."),
            started_at: None,
            updated_at: now,
            terminated: false,
            terminated_at: None,
            master_state_path,
            master_archive_error: None,
            master_error: Some(error),
            pre_purge_state,
            owner: None,
            daemon: DaemonStatus::unknown(),
            counts: KindCounts::default(),
            sessions: Vec::new(),
            merge_queue: Vec::new(),
            conflict_graph: ConflictGraph::default(),
            paused_for_user: None,
            recent_events: VecDeque::with_capacity(0),
            conversations: Vec::new(),
            summary_path: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct DaemonStatus {
    pub label: String,
    pub healthy: Option<bool>,
    pub pid: Option<u32>,
    pub last_heartbeat_at: Option<DateTime<Utc>>,
}

impl DaemonStatus {
    #[must_use]
    pub fn unknown() -> Self {
        Self {
            label: String::from("daemon: unknown"),
            healthy: None,
            pid: None,
            last_heartbeat_at: None,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct KindCounts {
    pub total: usize,
    pub adhoc: usize,
    pub issue: usize,
    pub workflow: usize,
    pub by_state: BTreeMap<SessionState, usize>,
}

impl KindCounts {
    #[must_use]
    pub fn from_sessions(sessions: &[TrackedSession]) -> Self {
        let mut counts = Self {
            total: sessions.len(),
            ..Self::default()
        };
        for session in sessions {
            match &session.kind {
                SessionKind::Adhoc => counts.adhoc += 1,
                SessionKind::Issue => counts.issue += 1,
                SessionKind::Workflow => counts.workflow += 1,
                SessionKind::Other(_) => {}
            }
            *counts.by_state.entry(session.state.clone()).or_insert(0) += 1;
        }
        counts
    }
}

#[derive(Debug, Clone)]
pub struct TrackedSession {
    pub id: String,
    pub title: String,
    pub kind: SessionKind,
    pub state: SessionState,
    pub substate: Option<String>,
    pub harness: Option<String>,
    pub window: Option<String>,
    pub pane_target: Option<String>,
    pub pane_id: Option<String>,
    pub cwd: Option<PathBuf>,
    pub launch: LaunchInfo,
    pub adapter: AdapterMetadata,
    pub domain: Option<DomainBlock>,
    pub last_response_at: Option<DateTime<Utc>>,
    pub spawned_at: Option<DateTime<Utc>>,
    pub last_polled_at: Option<DateTime<Utc>>,
    pub decisions_log: Vec<DecisionLogEntry>,
    pub stats: PaneStats,
}

impl TrackedSession {
    #[must_use]
    pub fn from_entry(key: String, entry: TrackedEntry) -> Self {
        let id = if entry.id.trim().is_empty() {
            key
        } else {
            entry.id
        };
        let title = entry.title.unwrap_or_else(|| id.clone());
        Self {
            id,
            title,
            kind: entry.kind,
            state: entry.state.unwrap_or_default(),
            substate: entry.substate,
            harness: entry.harness,
            window: entry.window,
            pane_target: entry.pane_target,
            pane_id: entry.pane_id,
            cwd: entry.cwd,
            launch: entry.launch.unwrap_or_default(),
            adapter: entry.adapter.unwrap_or_default(),
            domain: entry.domain,
            last_response_at: entry.last_response_at,
            spawned_at: entry.spawned_at,
            last_polled_at: entry.last_polled_at,
            decisions_log: entry.decisions_log,
            stats: PaneStats::default(),
        }
    }

    #[must_use]
    pub fn issue(&self) -> Option<&TrackedIssueDomain> {
        self.domain
            .as_ref()
            .and_then(|domain| domain.issue.as_ref())
    }

    #[must_use]
    pub fn latest_decision(&self) -> Option<&DecisionLogEntry> {
        self.decisions_log.iter().max_by_key(|entry| entry.ts)
    }
}

#[derive(Debug, Clone, Default)]
pub struct PaneStats {
    pub turns: Option<u32>,
    pub tokens: Option<u64>,
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct Event {
    pub ts: DateTime<Utc>,
    pub label: String,
}

#[derive(Debug, Clone)]
pub struct ConversationStream {
    pub entry_id: String,
    pub excerpt: String,
}
