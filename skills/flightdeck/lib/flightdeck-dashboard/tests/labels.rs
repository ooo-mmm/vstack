use flightdeck_dashboard::app::labels::{kind_badge, kind_label, state_label};
use flightdeck_dashboard::state::snapshot::SessionKind;

#[test]
fn state_and_kind_label_round_trip() {
    assert_eq!(state_label("prompting"), "Needs input");
    assert_eq!(state_label("waiting"), "Running");
    assert_eq!(state_label("ready"), "Idle");
    assert_eq!(state_label("merge-ready"), "Ready to merge");
    assert_eq!(state_label("dead"), "Stopped");
    assert_eq!(state_label("custom"), "custom");

    assert_eq!(kind_label("adhoc"), "Adhoc");
    assert_eq!(kind_label("issue"), "Issue");
    assert_eq!(kind_label("workflow"), "Workflow");
    assert_eq!(kind_label("other"), "other");
    assert_eq!(kind_badge(&SessionKind::Workflow), "WF");
}
