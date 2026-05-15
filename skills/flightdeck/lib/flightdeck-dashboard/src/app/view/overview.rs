use chrono::{DateTime, Utc};
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Cell, Paragraph, Row, Table, Wrap};
use ratatui::Frame;

use crate::app::model::{Model, ReadSourceState};
use crate::app::theme::Theme;
use crate::app::view::{fx, human_duration};
use crate::state::snapshot::{SessionState, TrackedSession};
use crate::state::tracked_entries::PRE_PURGE_BANNER;

const RIGHT_RAIL_MIN_WIDTH: u16 = 100;
const SINGLE_COLUMN_WIDTH: u16 = 80;

pub fn render(frame: &mut Frame<'_>, area: Rect, model: &Model, theme: Theme) {
    let area = render_transition_banners(frame, area, model, theme);
    if area.width <= SINGLE_COLUMN_WIDTH || model.ui.compact {
        render_single_column(frame, area, model, theme);
        return;
    }

    if area.width <= RIGHT_RAIL_MIN_WIDTH {
        let columns = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Length(28), Constraint::Min(20)])
            .split(area);
        render_left_rail(frame, columns[0], model, theme);
        render_session_table(frame, columns[1], model, theme);
        return;
    }

    let columns = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Length(28),
            Constraint::Min(60),
            Constraint::Length(44),
        ])
        .split(area);
    render_left_rail(frame, columns[0], model, theme);
    render_session_table(frame, columns[1], model, theme);
    render_detail(frame, columns[2], model, theme);
}

fn render_transition_banners(
    frame: &mut Frame<'_>,
    mut area: Rect,
    model: &Model,
    theme: Theme,
) -> Rect {
    if model.snapshot.pre_purge_state {
        area = render_banner(
            frame,
            area,
            " state schema warning ",
            PRE_PURGE_BANNER,
            theme.error,
        );
    } else if let Some(error) = &model.snapshot.master_error {
        area = render_banner(frame, area, " state read error ", error, theme.error);
    }
    match model.read_source_state {
        ReadSourceState::Archive { archived_at } => {
            area = render_banner(
                frame,
                area,
                " archive state ",
                &format!("Live state archived; showing terminated snapshot from {archived_at}."),
                theme.warning,
            );
        }
        ReadSourceState::Missing => {
            area = render_banner(
                frame,
                area,
                " missing state ",
                "No live state file or terminated archive found yet.",
                theme.muted,
            );
        }
        ReadSourceState::Live => {}
    }
    area
}

fn render_banner(
    frame: &mut Frame<'_>,
    area: Rect,
    title: &'static str,
    message: &str,
    style: ratatui::style::Style,
) -> Rect {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(3), Constraint::Min(0)])
        .split(area);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(style)
        .title(Span::styled(title, style));
    frame.render_widget(
        Paragraph::new(message.to_owned())
            .block(block)
            .style(style)
            .alignment(Alignment::Center),
        chunks[0],
    );
    chunks[1]
}

fn render_single_column(frame: &mut Frame<'_>, area: Rect, model: &Model, theme: Theme) {
    let snapshot = &model.snapshot;
    let elapsed = snapshot
        .started_at
        .map(|started| human_duration(started, model.now))
        .unwrap_or_else(|| String::from("unknown"));
    let mut lines = vec![Line::from(vec![
        Span::styled("Session ", theme.status_label),
        Span::raw(snapshot.session_id.clone()),
        Span::raw("  ·  "),
        Span::raw(format!(
            "AH:{}  ISS:{}  WF:{}",
            snapshot.counts.adhoc, snapshot.counts.issue, snapshot.counts.workflow
        )),
        Span::raw("  ·  "),
        Span::raw(elapsed),
    ])];
    if let Some(pause) = &snapshot.paused_for_user {
        lines.push(Line::from(vec![
            Span::styled("PAUSED ", theme.pause),
            Span::raw(
                pause
                    .entry_id
                    .as_deref()
                    .unwrap_or("unknown-entry")
                    .to_owned(),
            ),
            Span::raw("  "),
            Span::raw(pause.reason.clone()),
            pause
                .prompt_text
                .as_ref()
                .map(|prompt| Span::raw(format!(" · {prompt}")))
                .unwrap_or_else(|| Span::raw(String::new())),
        ]));
    }
    if snapshot.terminated {
        lines.push(Line::from(Span::styled("✔ session complete", theme.ok)));
    }
    lines.push(Line::from(""));
    for (idx, session) in snapshot.sessions.iter().enumerate() {
        let cursor = if idx == model.selected_index() {
            "›"
        } else {
            " "
        };
        let pr = session
            .issue()
            .and_then(|issue| issue.pr_number)
            .map(|pr| format!("PR #{pr}"))
            .unwrap_or_default();
        let style = if idx == model.selected_index() {
            theme.selection
        } else {
            theme.frame
        };
        lines.push(Line::from(vec![
            Span::styled(format!("{cursor} "), style),
            Span::styled(format!("{:<20}  ", session.id), style),
            Span::styled(
                format!("{:<12}", session.state.as_str()),
                theme.state(&session.state),
            ),
            Span::raw(" "),
            Span::styled(
                format!("{:<8}", session.harness.as_deref().unwrap_or("—")),
                style,
            ),
            Span::raw(" "),
            Span::styled(format!("{:<40}", truncate(&session.title, 40)), style),
            Span::styled(pr, style),
        ]));
    }
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border_active)
        .title(Span::styled(
            format!(" sessions ({} tracked) ", snapshot.counts.total),
            theme.title,
        ));
    frame.render_widget(
        Paragraph::new(lines).block(block).wrap(Wrap { trim: true }),
        area,
    );
}

fn render_left_rail(frame: &mut Frame<'_>, area: Rect, model: &Model, theme: Theme) {
    let mut lines = vec![Line::from(Span::styled("States", theme.header))];
    if model.snapshot.counts.by_state.is_empty() {
        lines.push(Line::from(Span::styled("no tracked entries", theme.muted)));
    } else {
        for (state, count) in ordered_state_counts(model) {
            lines.push(Line::from(vec![
                Span::styled(format!("{:<12}", state.as_str()), theme.state(&state)),
                Span::raw(format!(" {count}")),
            ]));
        }
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled("Merge queue", theme.header)));
    if model.snapshot.merge_queue.is_empty() {
        lines.push(Line::from(Span::styled("empty", theme.muted)));
    } else {
        for item in &model.snapshot.merge_queue {
            lines.push(Line::from(Span::raw(format!("• {item}"))));
        }
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled("Conflict graph", theme.header)));
    if model.snapshot.conflict_graph.edges.is_empty() {
        lines.push(Line::from(Span::styled("no edges", theme.muted)));
    } else {
        for (from, to) in &model.snapshot.conflict_graph.edges {
            lines.push(Line::from(Span::raw(format!("• {from} ↔ {to}"))));
        }
    }

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border)
        .title(Span::styled(" left rail ", theme.muted));
    frame.render_widget(
        Paragraph::new(lines).block(block).wrap(Wrap { trim: true }),
        area,
    );
}

fn render_session_table(frame: &mut Frame<'_>, area: Rect, model: &Model, theme: Theme) {
    let header = Row::new([
        Cell::from("Kind"),
        Cell::from("State"),
        Cell::from("Harness"),
        Cell::from("Title"),
        Cell::from("PR/worktree"),
        Cell::from("Age"),
        Cell::from("Decision"),
        Cell::from("Activity"),
    ])
    .style(theme.header);

    let rows = model
        .snapshot
        .sessions
        .iter()
        .enumerate()
        .map(|(idx, session)| {
            let row_style = if idx == model.selected_index() {
                theme.selection
            } else {
                theme.frame
            };
            Row::new(vec![
                Cell::from(Line::from(vec![
                    Span::styled(session.kind.badge(), theme.kind_badge(&session.kind)),
                    Span::raw(" "),
                    Span::styled(fx::spinner(model, session), theme.info),
                ])),
                Cell::from(Span::styled(
                    session.state.as_str(),
                    theme.state(&session.state),
                )),
                Cell::from(session.harness.as_deref().unwrap_or("—")),
                Cell::from(session.title.as_str()),
                Cell::from(issue_label(session)),
                Cell::from(age_label(session.spawned_at, model.now)),
                Cell::from(last_decision(session)),
                Cell::from(activity_label(session, model.now)),
            ])
            .style(row_style)
        })
        .collect::<Vec<_>>();

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border_active)
        .title(Span::styled(
            format!(" sessions ({} tracked) ", model.snapshot.counts.total),
            theme.title,
        ));
    let table = Table::new(
        rows,
        [
            Constraint::Length(7),
            Constraint::Length(12),
            Constraint::Length(10),
            Constraint::Percentage(26),
            Constraint::Percentage(20),
            Constraint::Length(8),
            Constraint::Percentage(20),
            Constraint::Length(12),
        ],
    )
    .header(header)
    .block(block)
    .column_spacing(1);
    frame.render_widget(table, area);
}

fn render_detail(frame: &mut Frame<'_>, area: Rect, model: &Model, theme: Theme) {
    let lines = match model.selected_session() {
        Some(session) => detail_lines(session, model, theme),
        None => vec![Line::from(Span::styled("No session selected", theme.muted))],
    };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border)
        .title(Span::styled(" detail ", theme.muted));
    frame.render_widget(
        Paragraph::new(lines)
            .block(block)
            .wrap(Wrap { trim: true })
            .alignment(Alignment::Left),
        area,
    );
}

fn detail_lines(session: &TrackedSession, model: &Model, theme: Theme) -> Vec<Line<'static>> {
    let mut lines = vec![
        Line::from(Span::styled(session.title.clone(), theme.title)),
        Line::from(vec![
            Span::styled("id ", theme.status_label),
            Span::raw(session.id.clone()),
        ]),
        Line::from(vec![
            Span::styled("kind ", theme.status_label),
            Span::raw(session.kind.to_string()),
            Span::raw("  "),
            Span::styled("state ", theme.status_label),
            Span::styled(session.state.to_string(), theme.state(&session.state)),
        ]),
    ];
    if let Some(substate) = &session.substate {
        lines.push(Line::from(vec![
            Span::styled("substate ", theme.status_label),
            Span::raw(substate.clone()),
        ]));
    }
    if let Some(pane) = &session.pane_id {
        lines.push(Line::from(vec![
            Span::styled("pane ", theme.status_label),
            Span::raw(pane.clone()),
        ]));
    }
    if let Some(cwd) = &session.cwd {
        lines.push(Line::from(vec![
            Span::styled("cwd ", theme.status_label),
            Span::raw(cwd.display().to_string()),
        ]));
    }
    if let Some(issue) = session.issue() {
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled("Issue domain", theme.header)));
        lines.push(Line::from(vec![
            Span::styled("issue ", theme.status_label),
            Span::raw(issue.id.clone()),
        ]));
        if let Some(pr) = issue.pr_number {
            lines.push(Line::from(vec![
                Span::styled("PR ", theme.status_label),
                Span::raw(format!("#{pr}")),
            ]));
        }
        if let Some(worktree) = &issue.worktree {
            lines.push(Line::from(vec![
                Span::styled("worktree ", theme.status_label),
                Span::raw(worktree.display().to_string()),
            ]));
        }
        lines.push(Line::from(vec![
            Span::styled("scope ", theme.status_label),
            Span::raw(format!(
                "declared={} actual={}",
                optional_count(issue.scope_files_declared),
                optional_count(issue.scope_files_actual)
            )),
        ]));
    }
    if let Some(pause) = &model.snapshot.paused_for_user {
        if pause
            .entry_id
            .as_deref()
            .is_some_and(|entry_id| entry_id == session.id)
        {
            lines.push(Line::from(""));
            lines.push(Line::from(Span::styled("PAUSED FOR USER", theme.pause)));
            lines.push(Line::from(vec![
                Span::styled("reason ", theme.status_label),
                Span::raw(pause.reason.clone()),
            ]));
            if let Some(prompt) = &pause.prompt_text {
                lines.push(Line::from(vec![
                    Span::styled("prompt ", theme.status_label),
                    Span::raw(prompt.clone()),
                ]));
            }
        }
    }
    if let Some(decision) = session.latest_decision() {
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled("Last decision", theme.header)));
        lines.push(Line::from(vec![
            Span::styled(decision.prompt_tag.clone(), theme.warning),
            Span::raw(" → "),
            Span::raw(decision.answer.clone()),
        ]));
    }
    lines
}

fn ordered_state_counts(model: &Model) -> Vec<(SessionState, usize)> {
    let priority = [
        SessionState::Prompting,
        SessionState::Submitting,
        SessionState::Waiting,
        SessionState::Ready,
        SessionState::MergeReady,
        SessionState::Complete,
        SessionState::Merged,
        SessionState::Cancelled,
        SessionState::Aborted,
        SessionState::Dead,
    ];
    let mut rows = Vec::with_capacity(model.snapshot.counts.by_state.len());
    for state in &priority {
        if let Some(count) = model.snapshot.counts.by_state.get(state) {
            rows.push((state.clone(), *count));
        }
    }
    for (state, count) in &model.snapshot.counts.by_state {
        if !priority.contains(state) {
            rows.push((state.clone(), *count));
        }
    }
    rows
}

fn optional_count(value: Option<u32>) -> String {
    value
        .map(|count| count.to_string())
        .unwrap_or_else(|| String::from("—"))
}

fn issue_label(session: &TrackedSession) -> String {
    let Some(issue) = session.issue() else {
        return String::from("—");
    };
    let pr = issue
        .pr_number
        .map(|number| format!("PR #{number}"))
        .unwrap_or_else(|| String::from("PR —"));
    let worktree = issue
        .worktree
        .as_ref()
        .and_then(|path| path.file_name())
        .and_then(|name| name.to_str())
        .unwrap_or("worktree?");
    format!("{pr} · {worktree}")
}

fn last_decision(session: &TrackedSession) -> String {
    session
        .latest_decision()
        .map(|decision| decision.prompt_tag.clone())
        .unwrap_or_else(|| String::from("—"))
}

fn activity_label(session: &TrackedSession, now: DateTime<Utc>) -> String {
    let activity = session
        .last_polled_at
        .or(session.last_response_at)
        .or(session.spawned_at);
    age_label(activity, now)
}

fn truncate(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let truncated = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

fn age_label(value: Option<DateTime<Utc>>, now: DateTime<Utc>) -> String {
    value
        .map(|time| human_duration(time, now))
        .unwrap_or_else(|| String::from("—"))
}
