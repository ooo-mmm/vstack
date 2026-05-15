use chrono::{DateTime, Utc};
use ratatui::layout::{Alignment, Constraint, Rect};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Cell, Paragraph, Row, Table, Wrap};
use ratatui::Frame;

use crate::app::model::Model;
use crate::app::theme::Theme;

#[derive(Debug, Clone)]
pub struct DecisionRow {
    pub entry_id: String,
    pub title: String,
    pub ts: DateTime<Utc>,
    pub prompt_tag: String,
    pub answer: String,
}

pub fn render(frame: &mut Frame<'_>, area: Rect, model: &Model, theme: Theme) {
    let rows = decision_rows(model);
    if rows.is_empty() {
        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(theme.border)
            .title(Span::styled(" decisions ", theme.muted));
        frame.render_widget(
            Paragraph::new("No decisions recorded yet.")
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
        Cell::from("Prompt tag"),
        Cell::from("Answer"),
    ])
    .style(theme.header);
    let table_rows = rows
        .iter()
        .enumerate()
        .map(|(idx, row)| {
            let row_style = if idx == model.selected_index() {
                theme.selection
            } else {
                theme.frame
            };
            Row::new([
                Cell::from(row.ts.format("%H:%M:%S").to_string()),
                Cell::from(format!("{} · {}", row.entry_id, truncate(&row.title, 24))),
                Cell::from(row.prompt_tag.clone()),
                Cell::from(truncate(&row.answer, 70)),
            ])
            .style(row_style)
        })
        .collect::<Vec<_>>();

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border_active)
        .title(Line::from(vec![
            Span::styled(" decisions ", theme.title),
            Span::styled("Enter opens answer detail", theme.muted),
        ]));
    let table = Table::new(
        table_rows,
        [
            Constraint::Length(9),
            Constraint::Length(34),
            Constraint::Length(28),
            Constraint::Min(40),
        ],
    )
    .header(header)
    .block(block)
    .column_spacing(1);
    frame.render_widget(table, area);
}

pub fn selected_decision(model: &Model) -> Option<DecisionRow> {
    decision_rows(model).get(model.selected_index()).cloned()
}

pub fn decision_rows(model: &Model) -> Vec<DecisionRow> {
    let mut rows = model
        .snapshot
        .sessions
        .iter()
        .flat_map(|session| {
            session.decisions_log.iter().map(|decision| DecisionRow {
                entry_id: session.id.clone(),
                title: session.title.clone(),
                ts: decision.ts,
                prompt_tag: decision.prompt_tag.clone(),
                answer: decision.answer.clone(),
            })
        })
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| right.ts.cmp(&left.ts));
    rows
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
