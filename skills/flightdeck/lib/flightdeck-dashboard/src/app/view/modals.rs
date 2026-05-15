use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Wrap};
use ratatui::Frame;

use crate::app::keymap::BINDINGS;
use crate::app::model::Model;
use crate::app::theme::Theme;
use crate::app::view::fx;

pub fn render_help(frame: &mut Frame<'_>, area: Rect, model: &Model, theme: Theme) {
    let popup = centered_rect(70, 70, area);
    frame.render_widget(Clear, popup);
    let mut lines = vec![
        Line::from(vec![
            Span::styled("Flightdeck dashboard help", theme.title),
            Span::raw("  "),
            Span::styled(fx::help_alpha_label(model), theme.muted),
        ]),
        Line::from(""),
    ];
    for binding in BINDINGS {
        lines.push(Line::from(vec![
            Span::styled(format!("{:<16}", binding.keys), theme.status_label),
            Span::raw(binding.description),
        ]));
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "Esc or ? closes this overlay",
        theme.footer,
    )));

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border_active)
        .title(Span::styled(" help ", theme.title));
    let paragraph = Paragraph::new(lines)
        .block(block)
        .alignment(Alignment::Left)
        .wrap(Wrap { trim: true });
    frame.render_widget(paragraph, popup);
}

fn centered_rect(percent_x: u16, percent_y: u16, area: Rect) -> Rect {
    let vertical = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage((100 - percent_y) / 2),
            Constraint::Percentage(percent_y),
            Constraint::Percentage((100 - percent_y) / 2),
        ])
        .split(area);
    let horizontal = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage((100 - percent_x) / 2),
            Constraint::Percentage(percent_x),
            Constraint::Percentage((100 - percent_x) / 2),
        ])
        .split(vertical[1]);
    horizontal[1]
}

pub fn render_decision_detail(frame: &mut Frame<'_>, area: Rect, model: &Model, theme: Theme) {
    let popup = centered_rect(72, 58, area);
    frame.render_widget(Clear, popup);
    let lines = if let Some(decision) = super::decisions::selected_decision(model) {
        vec![
            Line::from(vec![
                Span::styled("Session ", theme.status_label),
                Span::raw(format!("{} · {}", decision.entry_id, decision.title)),
            ]),
            Line::from(vec![
                Span::styled("Time ", theme.status_label),
                Span::raw(decision.ts.to_rfc3339()),
            ]),
            Line::from(vec![
                Span::styled("Prompt tag ", theme.status_label),
                Span::styled(decision.prompt_tag, theme.warning),
            ]),
            Line::from(""),
            Line::from(Span::styled("Answer", theme.header)),
            Line::from(decision.answer),
            Line::from(""),
            Line::from(Span::styled(
                "Esc or Backspace returns to decisions list",
                theme.footer,
            )),
        ]
    } else {
        vec![Line::from(Span::styled(
            "No decision selected",
            theme.muted,
        ))]
    };

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border_active)
        .title(Span::styled(" decision detail ", theme.title));
    let paragraph = Paragraph::new(lines)
        .block(block)
        .alignment(Alignment::Left)
        .wrap(Wrap { trim: true });
    frame.render_widget(paragraph, popup);
}
