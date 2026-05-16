# Flightdeck rich-activity handoff (2026-05-15)

Companion to [`docs/plans/flightdeck-rich-activity-events.md`](./flightdeck-rich-activity-events.md). Records the actual execution of the plan and what to inspect next.

## TL;DR

The rich-activity plan landed. Both PRs are open:

- **PR #64** — `flightdeck-dashboard-rust` → `main` — Rust ratatui dashboard with themes, cost engine, and confirmed write actions (57 commits, bases work this stack rests on).
- **PR #65** — `flightdeck-rich-activity` → `flightdeck-dashboard-rust` — 21 commits implementing the activity-events plan across flightdeck-core, the Rust dashboard, and 5 Pi extensions.

Merge order: #64 first, then #65.

## What ran

The W4 sequence followed the handoff's 7-phase activity-events plan. Each phase ran engineer → arch + error (+ test or structure per phase) → fix → re-review until clean, with `reviewer-doc` LAST in phase 7.

| Phase | Scope | Commits | Review rounds | Notable findings |
|---|---|---|---|---|
| 1 | Activity sidecar + flightdeck-state CLI + archive sentinel | 4 | 3 | Reviewer-arch caught the post-archive resurrection race; sentinel-based fix shipped |
| 2 | pane-registry state-transition emission | 2 | 2 | Reconcile drop now persists before emitting |
| 3 | Dashboard JsonlActivitySource + Activity tab | 3 | 2 | File-rotation detection via (dev, ino); archive sort by filename desc; schema_version v1 validation |
| 4 | Daemon + subscriber curated activity | 2 | 2 | Blocker: activity must NEVER block wake delivery. Fixed via nonblocking flock + post-wake emission order |
| 5 | Pi cross-extension activity broker | 5 | 2 | `Symbol.for("vstack.pi.activity")` + ring buffer; broker dedup keys align with legacy custom-message refs |
| 6 | Workflow + github/linear wrapper instrumentation | 2 | 1 (approve) | All wrappers gate on `FLIGHTDECK_MANAGED=1 \|\| FLIGHTDECK_ACTIVITY_FILE` |
| 7 | Cleanup + docs sweep | 3 (incl. reviewer-doc) | 1 + doc | reviewer-doc directly fixed a pi-flightdeck README accuracy claim (`ee15f2e`) |

Total: 21 commits since `edbd4c4`. 1 blocker, 11 majors, ~30 minors closed across all rounds.

## Architecture invariants

- **Wake routing unchanged.** `appendEvent` is canonical; activity is observation-only. Failed/blocked/needs_completion subagent completions still wake. Successful completions append activity without waking.
- **Activity emit is fail-open.** Nonblocking flock + short-timeout subprocess. Activity append failure NEVER breaks mutations, wake delivery, or harness control flow.
- **Wrapper gating consistent.** Shell + TS both gate on `FLIGHTDECK_MANAGED=1 || FLIGHTDECK_ACTIVITY_FILE`. Outside Flightdeck the github/linear wrappers behave identically to today.
- **Broker is a Pi-side curated channel.** Not chat noise; uses `pi-bridge stream` events (`event="vstack_activity"`), not `sendMessage()`. `FLIGHTDECK_PI_ACTIVITY_BROKER=0` falls back to legacy custom-message paths.
- **Archive sentinel** prevents post-archive appender resurrection: archive writes `<file>.archived` under the activity lock; append skips when the sentinel exists.

## Worktrees

- `/mnt/Tertiary/dev/vstack/trees/flightdeck-dashboard-rust` — branch `flightdeck-dashboard-rust`, HEAD `edbd4c4`.
- `/mnt/Tertiary/dev/vstack/trees/flightdeck-rich-activity` — branch `flightdeck-rich-activity`, HEAD `ee15f2e`.

Both worktrees are clean (`git status --short` empty). Keep them around for live validation until both PRs merge — the global vstack source still points at `main`, so `vstack refresh -g` does NOT install this PR's content until merge.

## Validation gates (HEAD)

```bash
cd skills/flightdeck/lib/flightdeck-core && bun test && bun run typecheck   # 350+ tests pass
cd pi-extensions/pi-session-bridge && bun test                              # pass
cd pi-extensions/pi-background-tasks && bun test                            # pass
cd pi-extensions/pi-agents-tmux && bun test                                 # pass
cd pi-extensions/pi-questions && bun test                                   # pass

cd skills/flightdeck/lib/flightdeck-dashboard
cargo fmt --check && cargo clippy --all-targets --all-features -- -D warnings && cargo test && cargo insta test
# 137+ tests pass; insta snapshots stable
```

## Followup issues filed (vanillagreencom/vstack)

Build-time pain points that did not block this PR but should be addressed:

- **#62** — pi-agents-tmux: `steer_subagent` throws "dashboardStatusFor is not a function" — blocks the tool entirely; `pi-bridge send --steer` is the workaround.
- **#63** — pi-core: subagent completely stalls after automatic context compaction — required manual `pi-bridge steer` to recover during Phase 6.
- **#66** — pi-agents-tmux: silent task abandonment when child's turn ends without `complete_subagent`.
- **#67** — pi-agents-tmux: agent stuck in tool-edit validation failures after compaction.
- **#68** — flightdeck-daemon: tracked-pane bell rings produce wake-storm during normal iteration.
- **#69** — flightdeck-daemon: `pi-bg-task-exit` wakes from subagent scaffolding are noisy.
- **#70** — flightdeck-daemon: master-gone shutdown should drop a structured recovery hint.
- **#71** — vstack install: reviewer-error subagent reports missing `.agents/skills/issue-lifecycle/SKILL.md`.
- **#72** — flightdeck-daemon: heartbeat could log `MemoryCurrent` of owner scope.

## Deliberate deferrals (NOT followup issues)

- Linear `issue_id` vs `linear_id` rename — deferred until non-Linear issue sources exist.
- pr-checks persisted transition memory — current impl observes `statusCheckRollup` per `pr-view` call; sufficient for the demo path, but persistent state would catch CI flakes that toggle.
- GitHub label instrumentation — no label wrapper exists yet; nothing to instrument until one does.

## How to live-validate the broker

Once #64 + #65 merge, run `vstack refresh -g` in any project that uses these extensions. The Pi broker activates automatically when Pi processes load the updated extensions. To verify end-to-end:

1. In a Flightdeck-managed tmux session, dispatch a subagent task.
2. Run `pi-bridge stream --filter event=vstack_activity` against the agent's pane — you should see structured activity rows.
3. Open the Rust dashboard's Activity tab — it tails `<state-dir>/flightdeck-activity-<session>.jsonl`.
4. Verify dedup: emit the same event twice via broker + legacy custom-message path; assert only one row appears in the JSONL.

## What's NOT in this PR

- pi-flightdeck (the deprecated Pi extension) does NOT consume the new JSONL sidecar. Its Live feed still tails the daemon log. The deprecation pointer stays; the Rust dashboard is the canonical UI for the activity stream. (reviewer-doc caught and corrected a misleading README claim about this — see `ee15f2e`.)
- The hyprtrade live-validation step from the original handoff has NOT been run — `vstack refresh -g` reported `0 updated` because the global source registry points at `main`, not this feature worktree. Live validation must wait for merge.

## Next session prompt

```
session execute @docs/plans/flightdeck-rich-activity-handoff.md
```

If the PRs are still open, the next session can:

1. Address review comments on #64 / #65 as they arrive.
2. Run the live validation against hyprtrade once merged.
3. Pick up any of the 9 filed followup issues (#62-63, #66-72) in priority order.
