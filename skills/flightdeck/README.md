# Flightdeck — human setup notes

Autonomous mission-control oversight of multi-issue parallel dev sessions running in tmux.

This file is for humans installing or debugging the skill. Agents should read `SKILL.md` instead.

## What it does

After orchestration's `start` workflow (or its parallel-group variant) launches one or more issue panes via `open-terminal`, the agent that ran the command becomes the master overseer of every spawned pane in the current tmux session. The exact invocation syntax depends on the harness (Claude Code uses `/orchestration start`, Codex uses `$orchestration start`, OpenCode uses `/orchestration start` or similar — see your harness docs). It:

- Polls each pane for prompts (bell flag, capture-pane sentinel matching).
- Classifies prompts and answers them with learned defaults.
- For prompts that trigger sub-agent delegation (rebase resolution, fix delegation), embeds the necessary guidance in the same input as the option pick (a follow-up message arrives too late).
- Watches PR state, builds a file-level conflict graph between in-flight PRs, plans merge order smallest-scope-first.
- Force-merges when a PR is APPROVED + all-green + content-disjoint and GitHub's `mergeStateStatus` has been `UNKNOWN` past the configured threshold.
- Detects scope creep (PR file count >2× declared) and escalates to the user.
- Terminates when every tracked issue is `merged | aborted | dead` and no prompts pending across two consecutive poll cycles.

## When it activates

- Inside tmux only (`$TMUX` set).
- After `open-terminal` in orchestration's `start.md` § 4.3 (single-issue) or § 4.4 (multi-issue).
- For 1 or more issues — single-issue tmux activates flightdeck just as much as multi-issue.

Outside tmux, flightdeck is a no-op.

## Installation

Flightdeck is published as a vstack skill. Install via the standard vstack flow:

```
cd /path/to/your/project
vstack add flightdeck
vstack refresh
```

vstack pulls flightdeck automatically when the orchestrator role is selected (it's listed under `[role-skills]` in `vstack.toml`). Manual installation is rarely needed.

## System Dependencies

- `jq`, `bash` 4+, `flock` (util-linux), `tmux` 3.x, `gh`

## Configuration (env vars)

| Variable | Default | Purpose |
|----------|---------|---------|
| `FLIGHTDECK_POLL_INTERVAL` | `30` | Seconds between poll cycles |
| `FLIGHTDECK_FORCE_MERGE_AFTER_SECS` | `240` | UNKNOWN-state wait threshold before considering force-merge |
| `FLIGHTDECK_STATE_DIR` | `tmp` | Master-state file directory |
| `FLIGHTDECK_DEBOUNCE_CYCLES` | `2` | Consecutive poll cycles for "all-done" termination |

## Scripts

Every script in `scripts/` appears in `SKILL.md`'s Scripts table. No hidden scripts.

| Script | What it does |
|--------|--------------|
| `open-terminal` | Launch worktree(s) with auto-detected harness — never hand-roll tmux/terminal commands |
| `parallel-groups` | Read/manage parallel issue groups |
| `flightdeck-state` | Atomic CRUD on `tmp/flightdeck-state-<TMUX_SESSION>.json` |
| `pane-registry` | Issue↔pane mapping wrapper |
| `pane-poll` | Bell + capture-pane (pane 0 explicit) + classify |
| `pane-respond` | Send to pane 0; validates rebase payloads have preserve/apply/verify triplet |
| `pane-clear-bell` | Atomic chained `select-window` cycle |
| `pr-conflict-graph` | File-intersection adjacency for a PR list |
| `prompt-classify` | Sentinel matcher → handler tag |

## Patterns docs

Lessons that motivated this skill, distilled into domain-grouped docs under `patterns/`:

- `tmux-monitoring.md` — pane-0 rule, bell handling, capture-pane idioms
- `prompt-handlers.md` — cleanup scope, combine-guidance, bot-review skip, rebase template, parent-vs-related, verify-don't-trust
- `conflict-detection.md` — defer-ci semantics, file-intersection algorithm, force-merge predicate
- `decision-biases.md` — smaller-PR-first, scope-creep detector, rule-of-three, expansion bias, merge-order tiebreakers

## Debugging

State file: `tmp/flightdeck-state-<TMUX_SESSION>.json`. Inspect with `jq`.

To see flightdeck's view of the world from outside:
```
$(.agents/skills/flightdeck/scripts/flightdeck-state get $SESSION) | jq
```

To see what flightdeck would do for a captured prompt without sending:
```
.agents/skills/flightdeck/scripts/prompt-classify --buffer-file /tmp/captured.txt --dry-run
```

If flightdeck is misbehaving, the most likely cause is a novel prompt shape that doesn't match any classifier sentinel. Check `prompt-classify` against the actual buffer; add a sentinel or escalate as `generic-multi-choice`.

## Pause / resume

Flightdeck pauses automatically on:
- detected scope creep needing revert
- force-merge against a real conflict
- issue abort
- `main` mutation
- novel prompt shape

When paused, it sets `paused_for_user` in master state and stops polling. Resume by running `watch` again — it picks up where it left off, including the `unknown_since` timer.

## Termination

When every tracked issue is `merged | aborted | dead` and no prompts pending across two consecutive cycles, flightdeck:
1. Writes `tmp/flightdeck-summary-<SESSION>-<TS>.md` containing:
   - Per-issue outcomes (merged PR #, aborted reason, time elapsed)
   - **New issues created during the run**, grouped by structural relation: children that were absorbed into the parent's PR vs. standalone follow-ups — each row showing `id`, `title`, `parent` (if any), `project`, `priority`
   - **Next-cycle recommendation**: which of the newly-created issues (if any) should be picked up before existing todo / active-cycle work, with a one-line rationale per recommended issue (e.g., "blocks CC-X which is in current cycle", "P2 vs current cycle's P3 backlog", "scope creep finding that should land before related restructure starts")
2. Sets `terminated: true` in master state.
3. Emits a single user-visible line summarizing counts (merged / aborted / new-issues / next-cycle-recommendations).
4. Returns control to orchestration's dashboard.

Panes are NOT closed — pane lifecycle stays with the user.

The next-cycle recommendation is just a recommendation — the user decides whether to start a new flightdeck session on the proposed issues immediately or stick with their planned cycle.

## Out of scope

- No automated abort logic — only the user can abort an issue.
- No re-spawn of dead panes — pane lifecycle is the user's.
- No multi-tmux-session coordination — flightdeck is scoped to the current `$TMUX` session.
- No bypass of orchestration's parallel safety checks — flightdeck activates only after `parallel-check` already cleared the spawn.
