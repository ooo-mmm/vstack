use chrono::Local;
use ratatui::layout::{Alignment, Constraint, Rect};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Cell, Paragraph, Row, Table, Wrap};
use ratatui::Frame;

use crate::app::model::Model;
use crate::app::motion::{Effect, EffectKind, EffectTarget};
use crate::app::theme::Theme;
use crate::state::snapshot::{Event, EventImportance};

pub fn render(frame: &mut Frame<'_>, area: Rect, model: &Model, theme: Theme) {
    let events = model.filtered_events();
    let hidden_noise = model.hidden_noise_count();
    let row_count = events.len().saturating_add(usize::from(hidden_noise > 0));
    let title = title_for(row_count, model);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border_active)
        .title(Span::styled(title, theme.title));

    if model.recent_events.is_empty() {
        frame.render_widget(
            Paragraph::new("Activity feed is empty. Daemon events appear here when the daemon writes to fd-daemon-<key>.log / fd-wake-events-<key>.log.")
                .block(block)
                .style(theme.muted)
                .alignment(Alignment::Center)
                .wrap(Wrap { trim: true }),
            area,
        );
        return;
    }

    let max_rows = area.height.saturating_sub(3) as usize;
    let mut rows = Vec::with_capacity(row_count.min(max_rows));
    if hidden_noise > 0 && rows.len() < max_rows {
        rows.push(row_for_folded_noise(hidden_noise, 0, model, theme));
    }
    let event_row_start = rows.len();
    let event_limit = max_rows.saturating_sub(event_row_start);
    rows.extend(
        events
            .iter()
            .take(event_limit)
            .enumerate()
            .map(|(idx, event)| row_for_event(event, idx + event_row_start, model, theme)),
    );
    let header = Row::new([
        Cell::from("Time"),
        Cell::from("Source"),
        Cell::from("!"),
        Cell::from("Message"),
    ])
    .style(theme.header);
    let table = Table::new(
        rows,
        [
            Constraint::Length(8),
            Constraint::Length(9),
            Constraint::Length(2),
            Constraint::Min(20),
        ],
    )
    .header(header)
    .block(block)
    .column_spacing(1);
    frame.render_widget(table, area);
}

fn title_for(row_count: usize, model: &Model) -> String {
    format!(
        " activity feed · {} row{} · {} ",
        row_count,
        if row_count == 1 { "" } else { "s" },
        if model.ui.hide_noise {
            "noise hidden"
        } else {
            "noise shown"
        }
    )
}

fn row_for_event<'a>(event: &Event, idx: usize, model: &Model, theme: Theme) -> Row<'a> {
    let entered = is_active(model, EffectKind::ActivityRowEnter, EffectTarget::Row(idx));
    let flash = is_active(
        model,
        EffectKind::ActivityImportantFlash,
        EffectTarget::Row(idx),
    );
    let accent = if entered { "↳ " } else { "" };
    let time = event
        .ts
        .with_timezone(&Local)
        .format("%H:%M:%S")
        .to_string();
    let importance_style = match event.importance {
        EventImportance::Low => theme.muted,
        EventImportance::Medium => theme.warning,
        EventImportance::Important => theme.error,
    };
    let source_style = if flash {
        theme.error
    } else {
        theme.kind_badge(&crate::state::snapshot::SessionKind::Workflow)
    };
    Row::new(vec![
        Cell::from(time),
        Cell::from(Span::styled(event.source.as_chip(), source_style)),
        Cell::from(Span::styled(event.importance.dot(), importance_style)),
        Cell::from(Line::from(vec![
            Span::styled(accent.to_owned(), theme.info),
            Span::raw(event.message.clone()),
        ])),
    ])
    .style(if idx == model.selected_index() {
        theme.selection
    } else {
        theme.frame
    })
}

fn row_for_folded_noise<'a>(count: usize, idx: usize, model: &Model, theme: Theme) -> Row<'a> {
    Row::new(vec![
        Cell::from("—"),
        Cell::from(Span::styled("NOISE", theme.muted)),
        Cell::from(Span::styled("·", theme.muted)),
        Cell::from(Span::styled(
            format!("{count} heartbeat/noise events folded · press Ctrl+N to show."),
            theme.muted,
        )),
    ])
    .style(if idx == model.selected_index() {
        theme.selection
    } else {
        theme.frame
    })
}

fn is_active(model: &Model, kind: EffectKind, target: EffectTarget) -> bool {
    model.active_effects.iter().any(|instance| {
        instance.kind == kind
            && instance.target == target
            && Effect::for_kind(kind).is_active(*instance, model.animate_frame)
    })
}
