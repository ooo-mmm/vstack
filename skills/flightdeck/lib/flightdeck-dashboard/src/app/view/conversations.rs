use chrono::{DateTime, Utc};
use ratatui::layout::{Alignment, Constraint, Rect};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Cell, Paragraph, Row, Table, Wrap};
use ratatui::Frame;

use crate::app::model::Model;
use crate::app::theme::Theme;
use crate::state::snapshot::ConversationStream;

pub fn render(frame: &mut Frame<'_>, area: Rect, model: &Model, theme: Theme) {
    if model.snapshot.conversations.is_empty() {
        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(theme.border)
            .title(Span::styled(" conversations ", theme.muted));
        frame.render_widget(
            Paragraph::new("No conversation excerpts captured yet.")
                .block(block)
                .style(theme.muted)
                .alignment(Alignment::Center)
                .wrap(Wrap { trim: true }),
            area,
        );
        return;
    }

    let header = Row::new([
        Cell::from("Time"),
        Cell::from("Session"),
        Cell::from("Role"),
        Cell::from("Excerpt"),
    ])
    .style(theme.header);
    let rows = model
        .snapshot
        .conversations
        .iter()
        .enumerate()
        .map(|(idx, conversation)| {
            let row_style = if idx == model.selected_index() {
                theme.selection
            } else {
                theme.frame
            };
            Row::new([
                Cell::from(time_label(conversation.ts)),
                Cell::from(session_label(conversation, model)),
                Cell::from(role_label(conversation)),
                Cell::from(conversation.excerpt.clone()),
            ])
            .style(row_style)
        })
        .collect::<Vec<_>>();

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border_active)
        .title(Line::from(vec![
            Span::styled(" conversations ", theme.title),
            Span::styled("newest first · pane ids hidden", theme.muted),
        ]));
    let table = Table::new(
        rows,
        [
            Constraint::Length(9),
            Constraint::Length(28),
            Constraint::Length(18),
            Constraint::Min(40),
        ],
    )
    .header(header)
    .block(block)
    .column_spacing(1);
    frame.render_widget(table, area);
}

fn session_label(conversation: &ConversationStream, model: &Model) -> String {
    model
        .snapshot
        .sessions
        .iter()
        .find(|session| session.id == conversation.entry_id)
        .map(|session| format!("{} {}", session.kind.badge(), truncate(&session.title, 22)))
        .unwrap_or_else(|| format!("entry {}", conversation.entry_id))
}

fn role_label(conversation: &ConversationStream) -> String {
    let role = conversation.role.as_deref().unwrap_or("unknown");
    if conversation.partial {
        format!("{role} (stream)")
    } else {
        role.to_owned()
    }
}

fn time_label(ts: Option<DateTime<Utc>>) -> String {
    ts.map(|value| value.format("%H:%M:%S").to_string())
        .unwrap_or_else(|| String::from("—"))
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
