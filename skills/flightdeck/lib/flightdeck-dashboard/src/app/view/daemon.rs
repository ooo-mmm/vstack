use chrono::{DateTime, Utc};
use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::Frame;

use crate::app::model::{Model, ReadSourceState};
use crate::app::theme::Theme;

pub fn render(frame: &mut Frame<'_>, area: Rect, model: &Model, theme: Theme) {
    let daemon = &model.snapshot.daemon;
    let heartbeat_count = model
        .recent_events
        .iter()
        .filter(|event| event.message.to_ascii_lowercase().contains("heartbeat"))
        .count();
    let heartbeat_label = daemon
        .last_heartbeat_at
        .map(|ts| format!("{} ago", age_label(ts, model.now)))
        .unwrap_or_else(|| String::from("not observed"));
    let health = match daemon.healthy {
        Some(true) => Span::styled("healthy", theme.ok),
        Some(false) => Span::styled("stopped", theme.error),
        None => Span::styled("unknown", theme.muted),
    };

    let mut lines = vec![
        Line::from(vec![Span::styled("Status ", theme.status_label), health]),
        Line::from(vec![
            Span::styled("Label ", theme.status_label),
            Span::raw(daemon.label.clone()),
        ]),
        Line::from(vec![
            Span::styled("PID ", theme.status_label),
            Span::raw(
                daemon
                    .pid
                    .map(|pid| pid.to_string())
                    .unwrap_or_else(|| String::from("—")),
            ),
        ]),
        Line::from(vec![
            Span::styled("Last heartbeat ", theme.status_label),
            Span::raw(heartbeat_label),
        ]),
        Line::from(vec![
            Span::styled("Heartbeat folding ", theme.status_label),
            Span::raw(format!(
                "{heartbeat_count} heartbeat event(s) folded into this row"
            )),
        ]),
        Line::from(vec![
            Span::styled("Snapshot diff drops ", theme.status_label),
            Span::raw(model.snapshot_diff_drops.to_string()),
        ]),
        Line::from(vec![
            Span::styled("Read source ", theme.status_label),
            Span::raw(read_source_label(model.read_source_state)),
        ]),
    ];
    if let Some(error) = &model.snapshot.master_archive_error {
        lines.push(Line::from(vec![
            Span::styled("Archive warning ", theme.status_label),
            Span::styled(error.clone(), theme.warning),
        ]));
    }
    if let Some(error) = &model.snapshot.master_error {
        lines.push(Line::from(vec![
            Span::styled("State error ", theme.status_label),
            Span::styled(error.clone(), theme.error),
        ]));
    }

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border_active)
        .title(Span::styled(" daemon ", theme.title));
    frame.render_widget(
        Paragraph::new(lines).block(block).wrap(Wrap { trim: true }),
        area,
    );
}

fn read_source_label(source: ReadSourceState) -> String {
    match source {
        ReadSourceState::Live => String::from("live state file"),
        ReadSourceState::Archive { archived_at } => format!("archive from {archived_at}"),
        ReadSourceState::Missing => String::from("missing"),
    }
}

fn age_label(ts: DateTime<Utc>, now: DateTime<Utc>) -> String {
    let seconds = now.signed_duration_since(ts).num_seconds().max(0);
    let minutes = seconds / 60;
    if minutes > 0 {
        format!("{minutes}m")
    } else {
        format!("{seconds}s")
    }
}
