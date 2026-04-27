# Workflow: `watch` — Master Loop

Master mode entry point. Polls every spawned issue pane, classifies their prompts, routes to handlers, plans merges, and drives every tracked issue to a terminal state.

**Inputs**: `[ISSUE_IDS]` — the issue list spawned by orchestration's `start.md` (auto-passed at handoff). Auto-detect `$TMUX_SESSION` via `tmux display-message -p '#S'`.

**Pre-conditions**: `$TMUX` set; orchestration just returned from `open-terminal` for one or more issues; `github` and `linear` skills loaded.

**Post-condition**: master state `terminated: true`, summary file written, control returned to orchestration's dashboard loop.

---

## § 1: Initialize Master State

1. Resolve session: `SESSION=$(tmux display-message -p '#S')`.
2. Init / resume master state:
   ```
   .agents/skills/flightdeck/scripts/flightdeck-state init
   ```
   Idempotent — preserves an existing state file if one exists (compaction-recovery path).
3. For each `ISSUE_ID` in the spawn batch, build / refresh registry entry:
   - Look up the spawned window by name (`open-terminal` names windows after the issue ID, lowercased).
   - Determine harness from the agent process running in pane 0 (`tmux list-panes -t <session>:<window> -F '#{pane_index} #{pane_current_command}'`).
   - Determine worktree path (passed by orchestration; cross-check `git worktree list`).
   - Pin the orchestrator-pane index by fingerprinting (see `patterns/tmux-monitoring.md` § Pane-0 rule). If only one pane, index 0.
   - Register:
     ```
     .agents/skills/flightdeck/scripts/pane-registry init <ISSUE_ID> \
       --window <window-name> --harness <h> --worktree <path> --pane-index <N>
     ```
4. If resuming, recompute the conflict graph against the live PR set in case PRs moved during compaction:
   ```
   .agents/skills/flightdeck/scripts/pr-conflict-graph <PR1> <PR2> ...
   ```
   Persist via `flightdeck-state set conflict_graph <json>`.

---

## § 2: Poll

For each tracked issue currently in a non-terminal state (`waiting | prompting | submitting | merge-ready`):

1. Run `pane-poll`:
   ```
   .agents/skills/flightdeck/scripts/pane-poll <session>:<window> <pinned-pane-index>
   ```
2. Parse JSON. If `dead: true` → `pane-registry set-state <ISSUE> dead` and continue.
3. Otherwise update state machine based on `tag`:

   | tag | new state | notes |
   |-----|-----------|-------|
   | `idle` | unchanged | nothing to do |
   | `rendering` | unchanged | re-poll next cycle |
   | `cleanup-prompt` | `prompting` | substate = tag |
   | `bot-review-wait-stuck` | `prompting` | substate = tag |
   | `rebase-multi-choice` | `prompting` | substate = tag |
   | `audit-relation-prompt` | `prompting` | substate = tag |
   | `merge-now` | `prompting` | substate = tag |
   | `merge-ready-but-unknown` | `prompting` | substate = tag; if `unknown_since` is null, set it now |
   | `force-merge-confirm` | `prompting` | substate = tag |
   | `external-fix-suggestions` | `prompting` | substate = tag |
   | `cycle-fix-suggestions` | `prompting` | substate = tag |
   | `descope-related` | `prompting` | substate = tag |
   | `generic-multi-choice` | `prompting` | substate = tag (handler will escalate) |

4. Hash debounce: if `capture_hash` matches `last_capture_hash` AND `bell == false`, skip routing — the prompt is the same one already handled.
5. Update `last_capture_hash` and `last_polled_at` on every poll.

---

## § 3: Decision Routing

For each issue currently in `state == "prompting"` and not debounced in § 2:

1. `⤵ workflows/handle-prompt.md <ISSUE_ID> <SUBSTATE_TAG> → § 4` — pass the captured buffer plus the classification tag. Handler decides the response (auto-answer, escalate, or "Type your own" with combined guidance).
2. After handler returns:
   - If a response was sent: `pane-respond` already cleared the bell and logged the decision via `pane-registry log-decision`.
   - If escalated to user: master state's `paused_for_user` is now populated; the watch loop yields control to the user. Resumption happens when the user re-invokes `watch`.
3. Re-poll the same window after a response to detect the next state (the agent typically advances to its next phase within a few seconds).

---

## § 4: Merge Planning

When **at least one** issue's state has reached `merge-ready` (the per-issue agent has emitted a "Merge now" prompt that handler approved, or auto-merge was triggered):

1. `⤵ workflows/merge-plan.md → § 5` — build the conflict graph from current PR file lists, smallest-scope-first ordering, execute the next safe merge.
2. After each merge, the merged issue transitions to `merged` and is removed from the active set. The graph mutates; merge-plan recomputes for the remaining queue.

---

## § 5: Bell Cleanup

`pane-respond` clears the bell on every successful send via the chained `select-window` idiom. No additional cleanup needed in the loop. If bells are observed on idle (no prompt) windows during § 2, clear them defensively:

```
.agents/skills/flightdeck/scripts/pane-clear-bell <session>:<window>
```

(Stale bells from earlier prompts the user manually answered.)

---

## § 6: Termination Check

At the end of each poll cycle:

1. Count issues by state. If every tracked issue is in `merged | aborted | dead` AND every issue's `state` is not `prompting` → increment a debounce counter.
2. If the debounce counter reaches `FLIGHTDECK_DEBOUNCE_CYCLES` (default 2) consecutive cycles → `⤵ workflows/terminate.md → END`.
3. Otherwise, yield until next poll cycle (use the harness's idle/wait mechanism — never `sleep`). Continue from § 2.

If `paused_for_user` is set, the loop yields immediately and waits for the user to re-invoke `watch` after addressing the pause.

---

## § 7: Compaction Recovery

Master state persists on every mutation. On `watch` re-entry after compaction (or an explicit user resume):

1. `flightdeck-state init` is idempotent — it loads the existing state file.
2. Re-fingerprint each registered window's pane 0 (TUIs may have re-laid-out across compaction).
3. Recompute every issue's `state` from a fresh `pane-poll`. Persisted state is a hint, not truth.
4. The `unknown_since` timer is preserved across compaction, so the force-merge clock does not reset.
5. Resume from § 2.

---

## Skip-If

- `$TMUX` unset → STOP block of `SKILL.md` already exited; this workflow is unreachable.
- `[ISSUE_IDS]` empty AND no existing state file → log a warning and exit (nothing to watch).

## Returns

To orchestration's dashboard loop, after `terminate.md` writes the summary and emits the user-visible line.
