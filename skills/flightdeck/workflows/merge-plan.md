# Workflow: `merge-plan` — Conflict Graph + Merge Order

Compute the file-intersection conflict graph for all `merge-ready` PRs, sort by smallest-scope-first, execute the next safe merge.

**Inputs**: master state (read-only at entry); the implicit list of `merge-ready` issues.

**Pre-conditions**: `watch.md` § 4 detected ≥1 issue in `merge-ready` state.

**Post-condition**: at most one merge executed per invocation; the merged issue transitions to `merged`; conflict graph and merge queue updated for the remaining set.

---

## § 1: Build Conflict Graph

1. Collect PR numbers for all issues currently in `merge-ready`:
   ```
   pane-registry list | jq '.[] | select(.state == "merge-ready") | .pr_number' | sort -u
   ```
2. Build the graph:
   ```
   .agents/skills/flightdeck/scripts/pr-conflict-graph <PR1> <PR2> ...
   ```
3. Persist:
   ```
   flightdeck-state set conflict_graph <graph-json>
   ```

---

## § 2: Sort Merge Queue

1. Read `prs[].file_count` from the graph output.
2. Sort ascending by `file_count`. Tiebreak by PR number ascending.
3. The result is the merge queue. Persist:
   ```
   flightdeck-state set merge_queue <ordered-issue-id-list>
   ```

See `patterns/decision-biases.md` § Smaller-PR-first merge order and § Merge-order tiebreakers for rationale.

---

## § 3: Execute Next Merge

1. Pop the head of `merge_queue`.
2. Re-validate immediately before merging:
   ```
   gh pr view <PR> --json mergeable,mergeStateStatus,reviewDecision,statusCheckRollup
   ```
3. Decision:
   - `MERGEABLE` + `CLEAN` + APPROVED + all-checks-green → invoke orchestration's per-issue merge workflow:
     ```
     ⤵ ../orchestration/workflows/merge-pr.md <PR> → § 4
     ```
   - `UNKNOWN` AND elapsed since first observed < `FLIGHTDECK_FORCE_MERGE_AFTER_SECS` → push back to queue tail; return to § 1 (graph unchanged).
   - `UNKNOWN` AND elapsed ≥ threshold AND force-merge predicate satisfied (see `patterns/conflict-detection.md`) → force-merge.
   - `DIRTY | BEHIND` with overlap → escalate (set `paused_for_user`); return to caller.
4. On successful merge:
   - `pane-registry set-state <ISSUE_ID> merged`.
   - `pane-registry set <ISSUE_ID> pr_number <number>` (if not already set).

---

## § 4: Recompute Graph

After each merge:

1. Remove the merged issue from `merge_queue`.
2. Recompute the graph against the remaining `merge-ready` issues — main has moved; some PRs may now be `BEHIND` and need rebase before becoming truly merge-ready again.
3. If any PR's state flipped to `BEHIND` post-merge, transition that issue back to `submitting` (its agent will detect the conflict on next sync and prompt for rebase, which the `rebase-multi-choice` handler covers).
4. Return to § 1 if more issues remain in the queue.

---

## § 5: Empty Queue

When `merge_queue` is empty after a merge or no `merge-ready` issues remain at entry, return to `watch.md` § 5. The watch loop continues polling for new merge-ready transitions.

---

## Skip-If

- No issue is currently in `merge-ready` state at entry → return immediately.

## Returns

To `watch.md` § 5 (bell cleanup) → § 6 (termination check).
