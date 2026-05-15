use flightdeck_dashboard::app::hitmap::{ClickAction, HitMap, ScrollSource};
use flightdeck_dashboard::app::model::Tab;
use ratatui::layout::Rect;

#[test]
fn tab_click_dispatches_select_tab() {
    let mut hitmap = HitMap::default();
    hitmap.push(
        Rect::new(1, 1, 10, 1),
        ClickAction::SelectTab(Tab::Daemon),
        0,
    );
    assert_eq!(hitmap.hit(3, 1), Some(ClickAction::SelectTab(Tab::Daemon)));
}

#[test]
fn row_click_dispatches_select_row() {
    let mut hitmap = HitMap::default();
    hitmap.push(Rect::new(0, 4, 80, 1), ClickAction::SelectRow(2), 0);
    assert_eq!(hitmap.hit(10, 4), Some(ClickAction::SelectRow(2)));
}

#[test]
fn banner_click_dispatches_jump_to_paused() {
    let mut hitmap = HitMap::default();
    hitmap.push(Rect::new(0, 3, 120, 1), ClickAction::JumpToPaused, 1);
    assert_eq!(hitmap.hit(40, 3), Some(ClickAction::JumpToPaused));
}

#[test]
fn popup_backdrop_click_closes_popup() {
    let mut hitmap = HitMap::default();
    hitmap.push(Rect::new(0, 0, 100, 40), ClickAction::CloseOverlay, 10);
    hitmap.push(Rect::new(20, 8, 60, 20), ClickAction::NoOp, 10);
    assert_eq!(hitmap.hit(2, 2), Some(ClickAction::CloseOverlay));
    assert_eq!(hitmap.hit(25, 10), None);
}

#[test]
fn scroll_dispatches_to_focused_panel() {
    let mut hitmap = HitMap::default();
    hitmap.push(
        Rect::new(0, 5, 100, 20),
        ClickAction::ScrollDown(ScrollSource::Activity),
        0,
    );
    assert_eq!(
        hitmap.hit(10, 8),
        Some(ClickAction::ScrollDown(ScrollSource::Activity))
    );
}
