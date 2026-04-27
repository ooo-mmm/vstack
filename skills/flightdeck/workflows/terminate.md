# Workflow: `terminate` — Final Summary + Next-Cycle Recommendation

End-of-session unwind. Composes a per-issue summary, the new-issues report, and a next-cycle recommendation. Marks master state terminated. Returns control to flightdeck's dashboard.

**Inputs**: master state (every tracked issue is `merged | aborted | dead`; debounce satisfied).

**Pre-conditions**: `watch.md` § 6 confirmed all-done across consecutive poll cycles.

**Post-condition**: `tmp/flightdeck-summary-<SESSION>-<TS>.md` written; `master_state.terminated = true`; user-visible summary line emitted; control returned to flightdeck's dashboard loop (`workflows/start.md` § 1).

---

## § 1: Compose Per-Issue Outcomes

For each tracked issue, gather:

| Field | Source |
|-------|--------|
| `id` | registry key |
| `state` | `merged | aborted | dead` |
| `pr_number` | registry |
| `merge_commit` | `gh pr view <PR> --json mergeCommit` (when `state == merged`) |
| `time_elapsed` | `now - master_state.started_at` per-issue if tracked, else session-level |
| `decisions_count` | length of `decisions_log` |
| `scope_files_declared` | registry |
| `scope_files_actual` | registry (or fetch from `gh pr view --json files`) |

---

## § 2: Compose New-Issues Report

Walk every issue's `decisions_log` for `audit-relation-prompt` entries. For each created issue captured during the session, gather:

| Field | Source |
|-------|--------|
| `id` | the new issue's id |
| `title` | from Linear (cached at creation time) |
| `parent` | parent issue id, or `null` |
| `project` | Linear project name |
| `priority` | Linear priority |
| `relation_kind` | `child` (parent absorbed it into the parent's PR) or `follow-up` (related/standalone) |
| `creating_session_issue` | which tracked issue's audit produced this new issue |

Group by `relation_kind`:
- **Children absorbed into parent PR** — these landed in the parent's branch and are already merged (or aborted with the parent).
- **Standalone follow-ups** — unblocked work that was deferred for separate handling.

---

## § 3: Compose Next-Cycle Recommendation

For each standalone follow-up (the `relation_kind: follow-up` set):

1. Compare its priority and tags to the user's current cycle / todo set:
   ```
   linear issues list --status Todo --max 100
   linear issues list --cycle current --max 100
   ```
2. Recommend picking up a follow-up before existing cycle/todo work iff at least one of:
   - The follow-up's priority is higher than any current-cycle issue.
   - The follow-up blocks an issue already in the current cycle (`linear issues list-relations <follow-up>` shows blocking edge).
   - The follow-up represents a critical discovery from this session (e.g., a P2 from a `bot-review-wait-stuck` cleanup, a scope-creep correction).
3. Build the recommendation list with one-line rationale per recommended issue.

If no follow-ups warrant precedence, the recommendation is "stick with planned cycle".

---

## § 4: Write Summary File

Emit to `tmp/flightdeck-summary-<SESSION>-<TS>.md` (TS = ISO8601, no colons):

```markdown
# Flightdeck Session Summary — <SESSION> — <ISO8601>

## Outcomes
| Issue | State | PR | Merge Commit | Elapsed | Decisions |
|-------|-------|----|--------------|---------|-----------|
| ...

## New Issues Created
### Children absorbed into parent PRs
| Issue | Title | Parent | Project | Priority |
|-------|-------|--------|---------|----------|
| ...

### Standalone follow-ups
| Issue | Title | Project | Priority |
|-------|-------|---------|----------|
| ...

## Next-Cycle Recommendation
- **Pick up next**: <ISSUE> — <one-line rationale>
- **Pick up next**: <ISSUE> — <one-line rationale>
... or "Stick with planned cycle — no created issues warrant precedence."

## Counts
- Merged: <N>
- Aborted: <N>
- New issues (children): <N>
- New issues (follow-ups): <N>
- Recommended next: <N>
```

---

## § 5: Finalize Master State

```
flightdeck-state set terminated true
flightdeck-state set terminated_at "\"<ISO8601>\""
```

Persist a pointer to the summary file path in master state for inspection later.

---

## § 6: User-Visible Output

Emit a single line to the user, e.g.:

```
Flightdeck: 5 merged, 0 aborted, 7 new issues (3 children, 4 follow-ups), 2 recommended for next cycle. Summary: tmp/flightdeck-summary-<SESSION>-<TS>.md
```

The recommendation is a recommendation — the user decides whether to start a new flightdeck session on the proposed issues immediately or stick with the planned cycle.

---

## § 7: Pane Lifecycle

Do **not** close panes. Pane lifecycle stays with the user — they may want to inspect transcripts post-session, or resume a paused issue manually.

The terminated master state means subsequent `watch` invocations on this `$TMUX_SESSION` will refuse to proceed (tell the user "session already terminated; use `watch --reset` to start over").

---

## Returns

To flightdeck's dashboard loop (`workflows/start.md` § 1).
