use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::Frame;

use crate::app::model::Model;
use crate::app::theme::Theme;
use crate::state::snapshot::SessionKind;

pub fn render(frame: &mut Frame<'_>, area: Rect, model: &Model, theme: Theme) {
    if !model.has_issue_sessions() {
        render_no_issue(frame, area, theme);
        return;
    }

    let columns = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(45), Constraint::Percentage(55)])
        .split(area);
    render_queue(frame, columns[0], model, theme);
    render_graph(frame, columns[1], model, theme);
}

fn render_no_issue(frame: &mut Frame<'_>, area: Rect, theme: Theme) {
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border)
        .title(Span::styled(" conflicts & merges ", theme.muted));
    frame.render_widget(
        Paragraph::new(
            "No ISS rows in this session. Merge metadata hidden for adhoc/workflow dashboards.",
        )
        .block(block)
        .style(theme.muted)
        .alignment(Alignment::Center)
        .wrap(Wrap { trim: true }),
        area,
    );
}

fn render_queue(frame: &mut Frame<'_>, area: Rect, model: &Model, theme: Theme) {
    let mut lines = vec![Line::from(Span::styled("Merge queue", theme.header))];
    if model.snapshot.merge_queue.is_empty() {
        lines.push(Line::from(Span::styled("empty", theme.muted)));
    } else {
        for (idx, item) in model.snapshot.merge_queue.iter().enumerate() {
            let issue_state = model
                .snapshot
                .sessions
                .iter()
                .find(|session| session.id == *item && session.kind == SessionKind::Issue)
                .map(|session| session.state.as_str())
                .unwrap_or("unknown");
            lines.push(Line::from(vec![
                Span::styled(format!("{}.", idx + 1), theme.status_label),
                Span::raw(" "),
                Span::styled(item.clone(), theme.kind_badge(&SessionKind::Issue)),
                Span::raw("  "),
                Span::styled(issue_state.to_owned(), theme.muted),
            ]));
        }
    }

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border_active)
        .title(Span::styled(" merge queue ", theme.title));
    frame.render_widget(
        Paragraph::new(lines).block(block).wrap(Wrap { trim: true }),
        area,
    );
}

fn render_graph(frame: &mut Frame<'_>, area: Rect, model: &Model, theme: Theme) {
    let mut lines = vec![Line::from(Span::styled(
        "Conflict graph / PR overlap",
        theme.header,
    ))];
    if let Some(computed_at) = model.snapshot.conflict_graph.computed_at {
        lines.push(Line::from(vec![
            Span::styled("computed ", theme.status_label),
            Span::raw(computed_at.to_rfc3339()),
        ]));
    }
    lines.push(Line::from(""));
    if model.snapshot.conflict_graph.edges.is_empty() {
        lines.push(Line::from(Span::styled("no conflicts", theme.ok)));
    } else {
        for (from, to) in &model.snapshot.conflict_graph.edges {
            lines.push(Line::from(vec![
                Span::styled(from.clone(), theme.warning),
                Span::raw(" ↔ "),
                Span::styled(to.clone(), theme.warning),
            ]));
        }
    }

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border_active)
        .title(Span::styled(
            " conflicts & merges (issue mode) ",
            theme.title,
        ));
    frame.render_widget(
        Paragraph::new(lines).block(block).wrap(Wrap { trim: true }),
        area,
    );
}
