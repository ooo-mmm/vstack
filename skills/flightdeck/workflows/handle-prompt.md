# Workflow: `handle-prompt` — Per-Pane Prompt Handler

Routes a single classified prompt to its handler logic, sends a response (or escalates), logs the decision.

**Inputs**: `<ISSUE_ID>`, `<TAG>` (substate from `prompt-classify`), captured buffer (from caller's last `pane-poll`).

**Pre-conditions**: master state initialized; issue is registered; state == `prompting`.

**Post-condition**: either a response was sent and decision logged, or `master_state.paused_for_user` is set with `{issue_id, reason, prompt_text}` and the watch loop will yield.

---

## § 1: Look Up Handler

Read `<ISSUE_ID>`'s registry entry to obtain `pane_target` and `worktree`:

```
.agents/skills/flightdeck/scripts/pane-registry get <ISSUE_ID>
```

Route by `<TAG>` to the matching subsection below. Each subsection is documented in detail in `patterns/prompt-handlers.md` and `patterns/conflict-detection.md`.

---

## § 2: Handler — `cleanup-prompt`

See `patterns/prompt-handlers.md` § Handler: `cleanup-prompt`.

1. Extract the target worktree path from the prompt buffer.
2. Compare to `<ISSUE_ID>.worktree` from the registry.
3. **Equal** → answer the affirmative option (typically `1` or `Yes`). `pane-respond <pane_target> "1"`.
4. **Not equal** → use a custom answer that scopes only to the asker's own worktree, or pick the negative option if the prompt is binary.
5. Log: `pane-registry log-decision <ISSUE_ID> cleanup-prompt <answer>`.

---

## § 3: Handler — `bot-review-wait-stuck`

See `patterns/prompt-handlers.md` § Handler: `bot-review-wait-stuck`.

1. Re-run `bot-review-wait` against the issue's PR with `--json` to get fresh per-reviewer status.
2. Apply decision matrix:
   - All reviewers `approved | skipped` → answer `Skip` option.
   - Any reviewer in `changes_reviewers` → escalate (review-feedback path, not bypass).
   - Pending reviewer past wait threshold AND user-known-noisy → set `BOT_SKIPPED_REVIEWERS` and answer `Skip`.
   - Pending reviewer that's blocking real review → escalate.
3. Log decision.

---

## § 4: Handler — `rebase-multi-choice`

See `patterns/prompt-handlers.md` § Handler: `rebase-multi-choice`.

1. Identify the **upstream issue** whose merged code now lives on main and may have logic the rebase must preserve. Heuristic: find the most recently merged issue from the master state's history that touched any file in `<ISSUE_ID>`'s PR.
2. From the upstream issue's PR, gather what to PRESERVE: changed function signatures, new wrappers, new parameters. Use `gh pr diff <upstream-PR>` against the conflict files.
3. From `<ISSUE_ID>`'s PR description / branch, gather what to APPLY: field renames, type updates, restructure surface.
4. Choose VERIFY: a test invocation that exercises the upstream fix's contract (e.g., specific test names added by the upstream PR).
5. Compose the combined payload (option label + preserve / apply / verify triplet — see `patterns/prompt-handlers.md` § Example shape).
6. Use the prompt's "Type your own answer" / "Chat about this" option to combine the option pick with the guidance.
7. Send via `pane-respond <pane_target> "<payload>" --tag rebase-multi-choice`. The script validates the triplet is present before sending.
8. Log decision.

---

## § 5: Handler — `audit-relation-prompt`

See `patterns/prompt-handlers.md` § Handler: `audit-relation-prompt`.

1. Parse the audit prompt to extract proposed new issues with their structure column (`child of <X>` / `related to <X>` / `none`).
2. For each proposed `child of <current-PR-issue>`:
   - Run a conflict check: would this child's scope (file refs in description, or inferred from title) intersect with any other live worktree's PR file set?
   - **No conflict** → accept `child of` (expansion bias).
   - **Conflict** → use `Type your own` to redirect — propose `related` instead, or a different parent.
3. For proposed `related to <X>` with `X` being the current-PR-issue → respect the audit (`related` is the safe default for follow-ups).
4. Submit the audit response with the master's structure choices applied.
5. Capture each created issue's `id`, `title`, `parent`, `project`, `priority` in master state for the end-of-session report — append to `<ISSUE_ID>.decisions_log` and to a top-level `created_issues` array (initialize on first creation).
6. Log decision.

---

## § 6: Handler — `merge-now`

The per-issue agent has prompted to merge its PR (review APPROVED, CI passing).

1. Re-fetch state: `gh pr view <PR> --json mergeable,mergeStateStatus,reviewDecision,statusCheckRollup`.
2. If `mergeable == "MERGEABLE"` AND `mergeStateStatus == "CLEAN"` AND review APPROVED AND no failing checks → answer `Merge` (typically option `1`).
3. If `mergeStateStatus == "UNKNOWN"` → transition to `merge-ready-but-unknown` substate (set `unknown_since` if null) and answer `Wait` if the prompt offers it; otherwise `Skip` and let the next cycle's poll catch the UNKNOWN handler.
4. If `mergeable == "CONFLICTING"` → escalate (genuine conflict; agent's question doesn't match reality).
5. Log decision.

---

## § 7: Handler — `merge-ready-but-unknown` & `force-merge-confirm`

See `patterns/conflict-detection.md` § Handler: `merge-ready-but-unknown`.

1. Compute `(now - unknown_since)`.
2. Evaluate force-merge predicate:
   - `reviewDecision == APPROVED`
   - All checks in `{SUCCESS, SKIPPED}`, zero `FAILURE`
   - `unknown_since` elapsed ≥ `FLIGHTDECK_FORCE_MERGE_AFTER_SECS`
   - Content disjoint: this PR's files don't intersect main's recent commits (use `pr-conflict-graph` against post-base PR head).
3. Re-fetch immediately before deciding. If state flipped to `DIRTY | BEHIND` with overlap → escalate.
4. **Predicate satisfied** → answer the affirmative force-merge option.
5. **Predicate not satisfied** → answer `Wait` if elapsed < threshold, else escalate.
6. Log decision.

---

## § 8: Handler — `external-fix-suggestions` & `cycle-fix-suggestions`

Per-issue agent surfaces a list of review-suggested fixes with options (All / subset / None).

1. For each fix item, evaluate per `patterns/decision-biases.md` § PR/branch expansion bias:
   - In-domain, mechanical, no defer-trigger → mark for inclusion.
   - Different scope / requires measurement / blocked dep → mark for defer (separate issue).
2. **All in-scope** → answer `All` (or equivalent).
3. **Mixed** → answer with the in-scope subset; flag deferred items for follow-up issue creation.
4. **Scope-creep risk** (the proposed fixes would push the PR's `actual_files` past `2 × declared_files`) → escalate.
5. Log decision.

---

## § 9: Handler — `descope-related`

The agent's reconciliation pass found that a sibling issue's scope has been partially absorbed by the current PR (e.g., a follow-up's first bullet is already implemented).

1. Default → answer the affirmative descope option. Reconciliation is a Linear-tracking action, not a code change.
2. Master state captures the descope action in `<ISSUE_ID>.decisions_log` for the end-of-session report.

---

## § 10: Handler — `generic-multi-choice`

No specific tag matched. The classifier returned a generic option-list.

1. **Always escalate**. Set `master_state.paused_for_user = {issue_id: <ISSUE>, reason: "novel-prompt-shape", prompt_text: <buffer-excerpt>}`.
2. The watch loop yields. The user inspects, answers manually (or instructs flightdeck via a custom command), and re-invokes `watch`.
3. After resumption, the prompt's hash will have changed (because the user's response advanced the agent), so debounce won't re-fire.

---

## Returns

To `watch.md` § 4 (or `§ 3` continuation if multiple windows are prompting in the same cycle).
