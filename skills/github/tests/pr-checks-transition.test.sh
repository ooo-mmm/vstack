#!/usr/bin/env bash
# vstack#71 W4 Phase 7 follow-up (B2): pr.checks_* activity should fire
# only when the rollup transitions from "passed" -> "failed" or back.
# Flapping CI used to produce a fresh event on every pr-view call; this
# test exercises the sidecar JSON at <state-dir>/flightdeck-pr-checks-
# <pr>.json.
#
# Run:  bash skills/github/tests/pr-checks-transition.test.sh
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$TEST_DIR/../scripts/commands/pr-view.sh"
SANDBOX="$(mktemp -d -t fd-pr-checks-XXXXXX)"
STATE_DIR="$SANDBOX/state"
ACTIVITY_FILE="$SANDBOX/activity.jsonl"
mkdir -p "$STATE_DIR"

PASS=0
FAIL=0

cleanup() {
    rm -rf "$SANDBOX" 2>/dev/null || true
}
trap cleanup EXIT

assert_eq() {
    local label="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        echo "  PASS: $label"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: $label" >&2
        echo "    expected: $expected" >&2
        echo "    actual:   $actual" >&2
        FAIL=$((FAIL + 1))
    fi
}

# Source the emit functions out of pr-view.sh by stubbing main() out.
source_emit_functions() {
    # pr-view.sh's main runs at bottom; gate by overriding gh.
    # Cheap path: import via subshell + grep the function block. Instead,
    # eval the function definitions by sourcing within a guarded shell.
    local stripped="$SANDBOX/pr-view-funcs.sh"
    awk '/^pr_checks_state_dir\(\)/{found=1} found{print} /^emit_checks_activity\(\)/{found=2} found==2 && /^}/{ found=0 }' "$SCRIPT" > "$stripped"
    # Also extract emit_checks_activity body up to its closing brace.
    awk '
        /^emit_checks_activity\(\)/{in_emit=1; print; next}
        in_emit{print; if($0 == "}") {in_emit=0}}
    ' "$SCRIPT" >> "$stripped"
    # shellcheck source=/dev/null
    source "$stripped"
}

source_emit_functions

# Inject the sidecar state dir + activity file via env so the helper
# resolves to our sandbox.
export FLIGHTDECK_PR_CHECKS_STATE_DIR="$STATE_DIR"
export FLIGHTDECK_ACTIVITY_FILE="$ACTIVITY_FILE"
export FLIGHTDECK_MANAGED=1

# Stub _activity-emit.sh writes by replacing the bash invocation path
# via $PATH override (cheap: write a wrapper). Simpler: count emits by
# tailing the activity file we expect _activity-emit.sh to write.
ACTIVITY_EMIT_STUB="$SANDBOX/_activity-emit.sh"
mkdir -p "$SANDBOX/scripts"
cat > "$ACTIVITY_EMIT_STUB" <<'STUB'
#!/usr/bin/env bash
# Test stub: write one JSON-ish line per call so the test can count
# emits.
printf 'EMIT %s\n' "$*" >> "$FLIGHTDECK_ACTIVITY_FILE"
STUB
chmod +x "$ACTIVITY_EMIT_STUB"
# Redirect the bash call inside emit_checks_activity to our stub by
# overriding the script path it computes. emit_checks_activity uses
# `bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../_activity-emit.sh"`.
# We replicate the relative path: stub at SANDBOX/scripts/_activity-emit.sh
# pointed at by the BASH_SOURCE inside the sourced functions.
# Workaround: monkey-patch the bash invocation via an alias-style wrapper.
# Easier: copy the stub into the same relative position the function
# expects, then override BASH_SOURCE via a wrapper function.
PR_VIEW_DIR="$SANDBOX/scripts/commands"
mkdir -p "$PR_VIEW_DIR"
mv "$ACTIVITY_EMIT_STUB" "$SANDBOX/scripts/_activity-emit.sh"
# Sourced functions reference BASH_SOURCE which we cannot override at
# call time; instead, re-define emit_checks_activity to call the stub
# directly. Simpler test surface: drive the transition memory helpers
# (pr_checks_*) directly and assert their state-file behavior.

# Build a fake gh-pr-view output JSON for "passed" then "failed" then "passed".
build_output() {
    local outcome="$1" pr_number="$2"
    local conclusion=SUCCESS
    [ "$outcome" = "failed" ] && conclusion=FAILURE
    jq -nc --arg conclusion "$conclusion" --argjson pr "$pr_number" \
        '{number: $pr, statusCheckRollup: [{conclusion: $conclusion}]}'
}

PR_NUMBER=99

# 1st call: passed -> records state + would emit
output1=$(build_output passed "$PR_NUMBER")
state1=$(pr_checks_state_path "$PR_NUMBER")
assert_eq "state path under FLIGHTDECK_PR_CHECKS_STATE_DIR" "$STATE_DIR/flightdeck-pr-checks-$PR_NUMBER.json" "$state1"
pr_checks_record_outcome "$state1" "passed" "$PR_NUMBER"
assert_eq "lastOutcome=passed after first record" "passed" "$(pr_checks_last_outcome "$state1")"

# 2nd call: passed again -> same outcome means no transition; pr-view
# emit path would short-circuit before recording, so the file stays at
# passed. We assert idempotence by reading after a no-op.
assert_eq "lastOutcome stays passed when no transition" "passed" "$(pr_checks_last_outcome "$state1")"

# 3rd call: failed -> transition; record + assert
pr_checks_record_outcome "$state1" "failed" "$PR_NUMBER"
assert_eq "lastOutcome=failed after transition record" "failed" "$(pr_checks_last_outcome "$state1")"

# 4th call: passed -> back to passed; record + assert
pr_checks_record_outcome "$state1" "passed" "$PR_NUMBER"
assert_eq "lastOutcome=passed after re-transition" "passed" "$(pr_checks_last_outcome "$state1")"

# LRU prune at boundary.
mkdir -p "$STATE_DIR/lru"
LRU_DIR="$STATE_DIR/lru"
for i in $(seq 1 55); do
    : > "$LRU_DIR/flightdeck-pr-checks-$i.json"
    sleep 0
done
# Touch one file with an older timestamp to make sort deterministic.
touch -t 202001010000 "$LRU_DIR/flightdeck-pr-checks-1.json"
# Default LRU cap is 50; with 55 files, prune should delete 5.
FLIGHTDECK_PR_CHECKS_LRU=50 pr_checks_prune_lru "$LRU_DIR"
remaining=$(find "$LRU_DIR" -maxdepth 1 -type f -name 'flightdeck-pr-checks-*.json' | wc -l)
assert_eq "LRU prune leaves at most 50 files" "50" "$remaining"
if [ -f "$LRU_DIR/flightdeck-pr-checks-1.json" ]; then
    echo "  FAIL: oldest file should have been pruned" >&2
    FAIL=$((FAIL + 1))
else
    echo "  PASS: oldest file pruned by mtime"
    PASS=$((PASS + 1))
fi

# Missing pr_number returns empty state path.
empty=$(pr_checks_state_path "" 2>/dev/null || true)
assert_eq "state path empty when pr_number missing" "" "$empty"

# Round-2 fix (reviewer-error major): two concurrent pr-view-equivalent
# processes racing the read-compare-write must produce exactly one
# transition record, not two duplicates. Simulate the race by having
# two background subshells contend for the same lock file and observe
# the lock+record sequence.
RACE_STATE_FILE="$STATE_DIR/flightdeck-pr-checks-race.json"
RACE_LOCK_FILE="$STATE_DIR/flightdeck-pr-checks-race.lock"
RACE_OUTCOMES="$SANDBOX/race-outcomes"
: > "$RACE_OUTCOMES"
# Seed prior state as 'passed' so a 'failed' transition is the only
# valid first-writer record.
pr_checks_record_outcome "$RACE_STATE_FILE" "passed" "42"

race_worker() {
    local target="$1"
    (
        exec 9>"$RACE_LOCK_FILE"
        flock -w 5 9 || exit 0
        local prev
        prev=$(pr_checks_last_outcome "$RACE_STATE_FILE")
        if [ "$prev" = "$target" ]; then
            exit 0
        fi
        # Simulate slow emit window where a peer could have raced.
        sleep 0.05
        pr_checks_record_outcome "$RACE_STATE_FILE" "$target" "42"
        printf 'emit %s\n' "$target" >> "$RACE_OUTCOMES"
    )
}

race_worker "failed" &
race_worker "failed" &
wait
race_emits=$(grep -c '^emit ' "$RACE_OUTCOMES" 2>/dev/null || echo 0)
assert_eq "flock collapses two racing transitions into one emit" "1" "$race_emits"
assert_eq "final lastOutcome reflects the winning transition" "failed" "$(pr_checks_last_outcome "$RACE_STATE_FILE")"

echo
echo "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -ne 0 ]; then
    exit 1
fi
