# PR Merge Workflow

Verify conditions and safely merge PR(s).

## Inputs

| Command | Flow |
|---------|------|
| `merge-pr` | List ready PRs, user selects |
| `merge-pr [N]` | Merge specific PR |
| `merge-pr all` | Batch merge all ready PRs |

## 1. Identify Candidates

```bash
.agents/skills/github/scripts/github.sh pr-list-ready
```

If no argument provided: present list, ask user for selection.

If `--all`: process all ready PRs sequentially.

## 2. Cross-Check PRs (if batch merge)

When `all` or 2+ PRs requested:

### 2.1 Run Quick Pre-Check

```bash
QUICK=$(.agents/skills/github/scripts/github.sh pr-cross-check [PR_NUMBERS] --quick --json)
```

If quick check finds high-severity issues (conflicts): Show issues, abort early.

### 2.2 Run Full Verification (if quick check passes)

```bash
echo "Running full verification (merge + build + test)..."
VERIFY=$(.agents/skills/github/scripts/github.sh pr-cross-check [PR_NUMBERS] --verify --json)
```

**Full verification does:**
1. Creates temp worktree from main
2. Merges PRs sequentially
3. Runs project build + test commands
4. Reports results + cleans up

### 2.3 Handle Results

| `can_batch_merge` | Action |
|-------------------|--------|
| `true` | Show "Verification passed", **→ Jump to § 3** with `merge_order` |
| `false` | Show failure details (merge/build/test logs), Ask user: `Abort` \| `Force anyway` |

**On failure**, display details:
```
Verification failed:
  [FAILURE_TYPE]: [FAILURE_DESCRIPTION]
     → [SUGGESTED_REMEDIATION]
```

## 3. Check Merge Readiness

For each PR:

```bash
CHECK=$(.agents/skills/github/scripts/github.sh pr-merge [PR_NUMBER] --check)
```

### 3.1 Resolve transient "unknown" before prompting

If `issues` contains an entry starting with `unknown:` (GitHub still computing
mergeable status), do NOT prompt the user — wait for resolution and re-check:

```bash
.agents/skills/github/scripts/github.sh await-mergeable [PR_NUMBER]
CHECK=$(.agents/skills/github/scripts/github.sh pr-merge [PR_NUMBER] --check)
```

`await-mergeable` polls `state` and `mergeStateStatus` (NOT `mergeable` —
that field stays UNKNOWN permanently after merge and will hang forever).
Returns when GitHub has computed a real merge state, or exits 124 on timeout.
On timeout, surface the failure to the user instead of looping further.

### 3.2 Parse and act

Parse result and present to user:

| `can_merge` | Action |
|-------------|--------|
| `true` | Show warnings if any, **→ Jump to § 4** |
| `false` | Show issues, Ask user: `Skip` \| `Fix and retry` \| `Force merge` |

**On issues**, display with guidance:
```
PR #N has issues:
  [CHECK_NAME]: [DESCRIPTION]
    → [SUGGESTED_FIX]
```

**On warnings only**, display and confirm:
```
PR #N ready with warnings:
  ⚠ [WARNING_TYPE]: [DESCRIPTION]
```
→ Ask user: `Merge anyway` | `Review first`

## 4. Prepare for Merge

### 4.1 Check Worktree Cleanup

```bash
ISSUE=$(.agents/skills/github/scripts/github.sh pr-issue [PR_NUMBER] --format=text)
[ -n "$ISSUE" ] && .agents/skills/worktree/scripts/worktree exists "$ISSUE"
```

If worktree exists: Ask user `"Cleanup worktree for [ISSUE_ID]?"` → store for § 5.

### 4.2 Verify Bot Token

```bash
.agents/skills/github/scripts/github.sh bot-token | jq -r '.configured'
```

If `false`: Ask user: `Merge as current user` | `Abort`

### 4.3 Detach Orphaned Children (Cascade-Done Guard)

Linear cascades the parent's Done state to all children. Any `make_child`
issue still pending under `[ISSUE]` will be silently flipped to Done on
merge. Detach them first.

**Skip if** no `[ISSUE]` extracted in § 4.1.

1. **List pending children** and partition by `state_type`:
   ```bash
   .agents/skills/linear/scripts/linear.sh cache issues children [ISSUE] --pending --recursive
   ```
   - **safe** — `state_type` is `backlog` or `unstarted` (Todo). Capture IDs as `[SAFE_IDS]`.
   - **active** — anything else (`started` = In Progress / In Review / custom started states; `triage`; any non-terminal custom type). Capture id + title + state name as `[ACTIVE]`.

   Both empty → § 5.

2. **`[ACTIVE]` non-empty** — pause and prompt the user before touching anything:

   > Cannot merge `[ISSUE]` cleanly. These sub-issues are still active and would be cascade-Done:
   > - `[ID]`: [title] ([state name])
   >
   > For each, was the work landed in this PR?
   > 1. Yes — close as Done (`linear.sh issues complete [ID]`)
   > 2. No — detach into the follow-up bundle (append to `[SAFE_IDS]`)
   > 3. Abort merge — resolve manually first

   Apply per-orphan, then continue. Choice 3 aborts § 4.3 entirely.

3. `[SAFE_IDS]` empty after step 2 → § 5.

4. **Rebundle `[SAFE_IDS]` under a new parent.**

   a. Read parent metadata. Capture `.title` → `[PARENT_TITLE]`, `.project.id` → `[PARENT_PROJECT]`, joined labels → `[PARENT_LABELS]`:
      ```bash
      .agents/skills/linear/scripts/linear.sh cache issues get [ISSUE] \
          | jq -r '"title=\(.title)\nproject=\(.project.id // .project.name // "")\nlabels=\([.labels.nodes[].name] | join(","))"'
      ```

   b. Compute `[BUNDLE_PRIORITY]` (highest-priority across `[SAFE_IDS]`; Linear: `1`=Urgent…`4`=Low, lower=higher; default `3`):
      ```bash
      .agents/skills/linear/scripts/linear.sh cache issues children [ISSUE] --pending --recursive \
          | jq '[.[] | select(.priority > 0) | .priority] | (min // 3)'
      ```

   c. Build `[BUNDLE_DESC]` per `.agents/skills/project-management/templates/parent-issue-template.md` — 1-2 sentence summary synthesized from orphan titles, `## Sub-Issues` listing each safe ID, `## Context` line: `Detached from [ISSUE] before merge to prevent cascade-Done.`

   d. Create the bundle. Capture printed ID as `[NEW_BUNDLE]`:
      ```bash
      .agents/skills/linear/scripts/linear.sh issues create \
          --title "[PARENT_TITLE] follow-ups" \
          --description "[BUNDLE_DESC]" \
          --project "[PARENT_PROJECT]" \
          --labels "[PARENT_LABELS]" \
          --priority [BUNDLE_PRIORITY] \
          --format=ids
      ```
      **Non-zero exit or empty output → abort the merge.** Better human intervention than silent loss.

   e. Reparent each `[SAFE_ID]` (one call per ID):
      ```bash
      .agents/skills/linear/scripts/linear.sh issues update [SAFE_ID] --parent [NEW_BUNDLE]
      ```

   f. Link bundle back + comment:
      ```bash
      .agents/skills/linear/scripts/linear.sh issues add-relation [NEW_BUNDLE] --related [ISSUE]
      .agents/skills/linear/scripts/linear.sh comments create [ISSUE] --body "Pending children rebundled under [NEW_BUNDLE] before merge to avoid cascade-Done."
      ```

5. → § 5.

## 5. Execute Merge

**Note**: Some harnesses reset cwd after each shell call. Use `cd && ...` chains or absolute paths — standalone `cd` does not persist.

1. **Resolve main repo root** (needed when session runs from inside a worktree):
   ```bash
   MAIN_REPO_ROOT=$(git rev-parse --git-common-dir | sed 's|/\.git$||')
   [[ "$MAIN_REPO_ROOT" == ".git" ]] && MAIN_REPO_ROOT="$PWD"
   echo "$MAIN_REPO_ROOT"
   ```

2. **Merge** (before cleanup — worktree survives if merge fails):
   ```bash
   (cd [MAIN_REPO_ROOT] && .agents/skills/github/scripts/github.sh pr-merge [PR_NUMBER] [--force])
   ```

   If exit code is `75` (queued for auto-merge), the merge will fire when CI
   and branch protection clear. Wait before downstream sync steps:
   ```bash
   (cd [MAIN_REPO_ROOT] && .agents/skills/github/scripts/github.sh await-mergeable [PR_NUMBER])
   ```
   Do NOT poll `gh pr view --json mergeable` inline — the field stays UNKNOWN
   permanently after merge and the loop never terminates. Always use the
   `await-mergeable` subcommand.

3. **Sync issue tracker cache** (merged PRs close issues via magic words — cache must reflect done states):
   ```bash
   (cd [MAIN_REPO_ROOT] && .agents/skills/linear/scripts/linear.sh sync --reconcile)
   ```

4. **Sync main repo** (ALWAYS runs after merge):
   ```bash
   (cd [MAIN_REPO_ROOT] && for remote in $(git remote); do git fetch "$remote" --prune || true; done && git pull --rebase && git worktree prune)
   ```
   **`--rebase`**: Prevents merge bubble commits when local main has direct commits while PRs land on remote.

5. **Sweep stale branches & worktrees** (after all PRs merged and synced):

   Find local branches whose remote PRs are already merged/closed:
   ```bash
   (cd [MAIN_REPO_ROOT] && git branch --format='%(refname:short)' | grep -v '^main$')
   ```

   For each branch, check PR status:
   ```bash
   gh pr list --head [BRANCH] --state all --json number,state -q '.[0].state'
   ```

   - **MERGED/CLOSED with no worktree**: Auto-delete (`git branch -D [BRANCH]`). Report in § 7.
   - **MERGED/CLOSED with worktree**: Ask user `"Stale worktree for [BRANCH] (PR already merged). Remove?"`. If yes: `(cd [MAIN_REPO_ROOT] && .agents/skills/worktree/scripts/worktree remove [ISSUE_ID])` then `git branch -D [BRANCH]`.
   - **OPEN**: Leave alone (active work).
   - **No PR found**: Ask user `"Local branch [BRANCH] has no associated PR. Delete?"`. Show last commit for context.

   Also check for orphan worktree directories:
   ```bash
   ls [TREES_DIR]/ | while read d; do
       git worktree list --porcelain | grep -q "$d" || echo "orphan: $d"
   done
   ```
   If orphans found: Ask user before `rm -rf`.

6. **Cleanup current worktree** (if cleanup requested in § 4.1 — **must be last**, destroys session cwd):
   ```bash
   (cd [MAIN_REPO_ROOT] && .agents/skills/worktree/scripts/worktree remove "[ISSUE_ID]")
   ```
   **Session launched from worktree**: If this prints `SESSION CWD DESTROYED`, the shell cwd no longer exists. Present § 7 results immediately, then tell the user to end the session. No further shell calls will succeed.

   Skip if cleanup was not requested.

## 6. Post-Merge Quality Review (overlapping files only)

**Skip** if § 2.1 found no file overlaps, or if session cwd was destroyed in § 5 step 6.

For each file flagged as overlapping in § 2.1:

1. **Capture pre/post diff**:
   ```bash
   git diff [PRE_MERGE_SHA]..HEAD -- [FILE]
   ```
   Where `PRE_MERGE_SHA` is the main branch commit before the first merge in § 5.

2. **Read the full merged file** and review for:
   - Duplicate or near-duplicate imports/usings
   - Methods/blocks from different PRs that should be reordered for logical grouping
   - Redundant error handling (both PRs added similar guards)
   - Inconsistent patterns (one PR uses pattern A, another uses pattern B for the same concern)
   - Dead code introduced by the combination (PR A adds a helper, PR B adds the same inline)

3. **Act on findings**:
   - **Auto-fix**: Duplicate imports, obvious ordering issues, trivial style inconsistencies → fix directly, commit as `fix(merge): clean up overlapping changes from PRs #X, #Y`
   - **Present to user**: Semantic issues requiring judgment (conflicting patterns, redundant logic where it's unclear which to keep) → describe the issue, propose a fix, ask user to confirm
   - **No issues**: Report `✅ Overlapping files reviewed — no quality issues` in § 7

## 7. Present Results

### Single PR

<output_format>

### ✅ MERGED — PR #[N]: [TITLE]

| Field | Value |
|-------|-------|
| Branch | [BRANCH_NAME] (deleted) |
| Worktree | cleaned up |
| Issue Tracker | [ISSUE_ID] → Done (via magic words) |
</output_format>

### Multiple PRs (`all`)

<output_format>

### 🔍 CROSS-PR ANALYSIS

| Check | Result |
|-------|--------|
| File overlaps | ✅ None |
| Dependencies | ⚠️ #[N] → #[M] (merged in order) |

### 📋 MERGE SUMMARY

| Status | PR | Issue | Note |
|--------|-----|-------|------|
| ✅ | #[N] | [ISSUE_ID] - [TITLE] | Merged |
| ✅ | #[M] | [ISSUE_ID] - [TITLE] | After #[N] |
| ⏭️ | #[P] | [ISSUE_ID] - [TITLE] | Review threads |
| ❌ | #[Q] | [ISSUE_ID] - [TITLE] | Merge conflicts |

Total: [N] PRs merged | Synced: git fetch --prune && git pull

### 🧹 STALE CLEANUP

| Action | Branch | Reason |
|--------|--------|--------|
| 🗑️ | [BRANCH_NAME] | PR #[N] merged |
| ⏭️ | [BRANCH_NAME] | User kept |

Legend: ✅ merged  ⏭️ skipped (user)  ❌ skipped (error)  🗑️ cleaned
</output_format>

---

## 8. Return State

**If managed**: Return to the parent workflow's next section.

**If standalone**: Session complete — merge results presented in § 7.