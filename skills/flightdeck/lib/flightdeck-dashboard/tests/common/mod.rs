#![allow(dead_code)]

use chrono::{DateTime, TimeZone, Utc};
use flightdeck_dashboard::app::command::SnapshotSource;
use flightdeck_dashboard::app::model::{Model, Tab};
use flightdeck_dashboard::app::motion::MotionLevel;
use flightdeck_dashboard::app::view;
use flightdeck_dashboard::fixtures;
use ratatui::backend::TestBackend;
use ratatui::Terminal;

pub const SNAPSHOT_WIDTH: u16 = 200;
pub const SNAPSHOT_HEIGHT: u16 = 60;

pub fn fixed_now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 5, 15, 10, 10, 0)
        .single()
        .expect("fixed timestamp is valid")
}

pub fn model_for_fixture(name: &'static str, motion: MotionLevel) -> Model {
    let snapshot = fixtures::load_demo_snapshot(name, fixed_now()).expect("fixture loads");
    let mut model = Model::new(snapshot, SnapshotSource::Demo(name), motion, fixed_now);
    model.current_pane_id = None;
    model
}

pub fn model_for_tab(tab: Tab) -> Model {
    let mut model = model_for_fixture("mixed", MotionLevel::Off);
    model.current_tab = tab;
    model
}

pub fn render_model(model: &Model) -> String {
    let backend = TestBackend::new(SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT);
    let mut terminal = Terminal::new(backend).expect("test backend creates terminal");
    terminal
        .draw(|frame| view::render(frame, model))
        .expect("render succeeds");
    format!("{}", terminal.backend())
}
