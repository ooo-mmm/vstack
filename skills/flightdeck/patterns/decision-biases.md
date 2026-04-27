# Decision biases

The master's default decision posture across the recurring choices that arise in multi-issue sessions. Overridable per-issue when the user provides specific instruction.

## PR/branch expansion bias

**Default**: when a review surfaces a follow-up finding inside the current PR's domain, prefer fixing it inline in this PR over deferring to a new issue.

### When to defer instead

- **Different scope**: the finding is a different concern (e.g., reviewing a clippy-hygiene PR; finding is a perf measurement). Concrete different, not "tidiness different".
- **Different agent**: the fix needs a domain agent the current PR's agent isn't (e.g., rust agent vs iced agent).
- **Requires measurement**: the fix can't be made without first running benchmarks or profiling that the current PR doesn't include.
- **Blocked dependency**: the fix needs another issue's work first.
- **Architectural decision needed**: the fix isn't mechanical; it requires a design choice that should be tracked.

### How to apply

For prompts like `Apply the external review fix suggestions?` or `Apply fix suggestions?`:

- Default → answer "All" or "Yes" if findings are within domain.
- If findings include a clear-defer reason (use the list above), pick the subset and create a follow-up issue for the deferred finding.
- Never pick "None" unless every finding hits a defer reason.

## Scope-creep detector

**Rule**: an issue's PR should touch a file count proportional to its declared scope. If `actual > 2 × declared`, flag as scope creep and escalate to user.

### Computing declared scope

Parse the issue description for file references. Heuristics:

- Backtick-quoted paths: `` `path/to/file.rs` ``
- "Files:" or "Touches:" sections
- Regex: `(?:[\w/-]+/)+[\w-]+\.\w+` matched against issue body

If no files are listed, default to the rough scope inferred from the issue title (e.g., "clippy hygiene" implies a small set; "split store.rs" implies one file plus its tests).

### Computing actual scope

```bash
gh pr view <N> --json files --jq '.files | length'
```

### Trigger

- `actual / declared > 2.0` AND `actual > 5` (avoid false-positives on tiny issues)
- Persist `scope_files_declared` and `scope_files_actual` in master state for traceability.

### What to do

- **Always escalate to user.** Never auto-revert — sometimes expansion is the right call (e.g., reviewer suggested the broader change). Master can't distinguish good expansion from runaway scope.
- Include in the user-prompt: declared scope, actual scope, list of files NOT in the declared set.
- The user decides: accept the expansion, ask the agent to revert/split, or amend the issue scope.

## Smaller-PR-first merge order

**Rule**: when two PRs overlap on files, merge the smaller-scoped one first. The bigger PR absorbs the rebase against the smaller one's renames, not the other way around.

### Implementation

In `merge-plan.md` § 2:

1. Build conflict graph from `pr-conflict-graph`.
2. Topologically sort by file count ascending.
3. Tie-broken by PR number (smaller PR # first — usually older, less churn).
4. Re-evaluate after each merge: the graph mutates as PRs land.

### Edge case: no overlap

If all PRs are file-disjoint, order doesn't matter for correctness. Default to PR-number ascending for predictability.

## Rule of three

**Rule**: don't extract a shared helper across <3 sibling sites. At 2 sites the abstraction shape isn't yet visible; at 3 it's constrained enough to fit. Test helpers especially benefit from locality over DRY.

### When to flip the default

If the same review pass discovers a 3rd site already exists (e.g., reviewer notes "this same helper appears in sibling test files X, Y, Z"), rule-of-three is satisfied at the moment of review. Flip from "defer" to "extract now".

### How to apply

For prompts like `Consolidate tick() helper across market_data test files?`:

- Look at the suggestion's site count.
  - 2 sites → defer; create a follow-up issue with trigger "when 3rd sibling appears".
  - 3+ sites → extract; apply per expansion bias if same domain as current PR.

## Merge-order tiebreakers

When multiple PRs are simultaneously ready (`merge-ready`):

1. **Smallest scope first** — file count ascending.
2. **Overlapping files: smaller goes first** — already covered by (1) in most cases; explicit rule when sizes are close.
3. **PR number ascending as final tiebreaker** — predictability.

### Re-evaluate after each merge

Merging changes `main`. Other PRs may now be:
- BEHIND main → need rebase before merge.
- CONFLICTING → need rebase + manual resolution.
- Still CLEAN → can proceed.

After each merge, recompute the conflict graph from current PR file lists and re-sort the queue.

### When merge fails on a force-merge attempt

If the predicate said safe but the merge actually conflicts (e.g., GitHub state flipped between predicate check and merge call):

1. Don't retry blindly.
2. Mark the issue's substate as `merge-blocked`.
3. Escalate to user with the conflict file list.
4. The user decides whether to rebase, abort, or override.

