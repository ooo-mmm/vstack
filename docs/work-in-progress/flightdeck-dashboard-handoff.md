# Flightdeck Dashboard — Handoff

**Branch:** `flightdeck-dashboard-rust`
**Worktree:** `/mnt/Tertiary/dev/vstack/trees/flightdeck-dashboard-rust`
**HEAD as of handoff:** `d8cc0f328236c2230f08739effd51021de0217b8`

## What's done

- Phase 0 — Rust dashboard crate and trampoline scaffolded under `skills/flightdeck/lib/flightdeck-dashboard/` and `scripts/flightdeck-dashboard`.
- Phase 1 — Read-only ratatui TUI landed with theme tokens, motion controls, overview snapshots, demo fixtures, and safe terminal cleanup.
- Phase 2 — Master-state reader normalized `.entries`, issue-domain fields, archive fallback, pre-purge detection, stale chips, and observer affordances.
- Phase 3 — Live file watching, activity feed scaffolding, daemon/wake JSONL tail sources, and bounded motion effects landed.
- Phase 4 — Rust daemon read shim, UDS JSON-RPC snapshot stream, lifecycle cleanup, bounded RPC frames, and daemon status/tail commands landed.
- Phase 5 — Pi-only subscriber absorption landed behind `FLIGHTDECK_DAEMON_RUST=1`, with bg-task exit, question, classifier fallback, and lifecycle coverage.
- Phase 6 — `flightdeck-dashboard launch` integrated with `flightdeck-session start --kind workflow`, best-effort tmux behavior, motion forwarding, and workflow hook docs.
- Phase 7 — Pi-flightdeck parity sign-off added snapshots, fixtures, compact dashboard, decisions popup, archive fallback, observer mode, and deprecation banner for new Pi sessions.
- Phase 8 — Full-stack validation chain verified; missing `bun-types` was resolved by `bun install`, and `cd cli && cargo test` works from the worktree root.
- Phase 9 — Live tmux/Flightdeck smoke plan is documented; remaining smokes are operator/live-environment checks for bell, focus staying manual, archive fallback, and dashboard launch tracking.
- Phase 10 — Cross-harness subscriber expansion remains future work; non-Pi subscriber modules are explicit stubs.
- Phase 11 R1 — Fixed TUI auto-focus removal, state-file creation boundary, Pi subscriber/test splits, subagent completion wake parity, bounded tail/client/socket IO, orphan subscriber cleanup, and minor cleanup.
- Phase 11 R2 — Tailer now carries partial records across chunk boundaries, truncates oversize records with an Activity error, and subscribe-race coverage asserts exactly-once snapshot delivery.

## How to run the dashboard

Build the release binary after `vstack add`:

```bash
cd skills/flightdeck/lib/flightdeck-dashboard
cargo build --release
```

Launch the tracked dashboard window from inside a Flightdeck tmux session:

```bash
.agents/skills/flightdeck/scripts/flightdeck-dashboard launch
```

Run demo or direct state reads during development:

```bash
cd skills/flightdeck/lib/flightdeck-dashboard
cargo run --release -- tui --demo
cargo run --release -- tui --demo=mixed
cargo run --release -- tui --state-file ../../tests/fixtures/state/entries-happy.json
cargo run --release -- tui --session "$TMUX_SESSION_NAME"
```

Opt into the Rust daemon wake side only when testing subscriber absorption:

```bash
FLIGHTDECK_DAEMON_RUST=1 .agents/skills/flightdeck/scripts/flightdeck-dashboard launch
```

## Known limitations

- Phase 5 subscriber absorption is Pi-only; Claude / OpenCode / Codex / tmux fallback are stubs.
- `pi-empty-after-compact` wake emission is deferred until the TS daemon's canonical tag set includes it.
- TUI in Phase 1 is read-only — no responding to pane prompts, no master-resume. Phase 2 writes are the next-cycle scope.
- `FLIGHTDECK_DAEMON_RUST=1` is opt-in. Default off keeps the canonical TS daemon in charge of wake delivery.

## Follow-up backlog

- TS daemon's canonical tag set + `pi-empty-after-compact` wake (paired Rust+TS PR).
- Subscriber absorption: Claude / OpenCode / Codex / tmux fallback.
- TUI write paths (Phase 2+).
- Activity-events sidecar (companion plan: `flightdeck-rich-activity-events.md`).
- Default-flip of `FLIGHTDECK_DAEMON_RUST` after a production cycle.

## Mitigations for the 2026-05-15 OOM event

See `tmp/2026-05-15-memory-incident.md` and `tmp/2026-05-15-vstack-followups.md` on `main`. The dashboard's autonomous-run loop now dispatches heavy cargo invocations into subagent panes (separate cgroup scopes) so master never accumulates the page cache.
