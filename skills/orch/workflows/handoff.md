# Handoff Workflow

Launch one or more independent work item sessions. This is launch-only.

## Inputs

| Input | Meaning |
|-------|---------|
| `tracker` | `linear` or `github` |
| `items` | Linear IDs or GitHub issue numbers |
| `repo` | Required for GitHub if `gh repo view` cannot resolve |
| `harness` | `claude`, `codex`, `codex-app`, `opencode`, or `pi` |

## 1. Confirm Launch

Present:

<output_format>
### Launch Handoff

| Field | Value |
|-------|-------|
| Tracker | [linear|github] |
| Items | [ITEMS] |
| Harness | [HARNESS] |
| Follow-up | No monitoring; each launched session owns its work item |
</output_format>

## 2. Launch

### Codex App

**Skip if** `harness != codex-app`.

Use this branch only for app-visible Codex Desktop handoff. Prefer native Codex app thread-management tools exposed by the current runtime.

For each item:

1. Create or reuse the worktree:
   ```bash
   # Linear
   WT_PATH=$(.agents/skills/worktree/scripts/worktree create [ISSUE_ID])

   # GitHub
   WT_PATH=$(.agents/skills/worktree/scripts/worktree create issue-[N])
   ```
2. If native thread tools are available, create one Codex app thread with `cwd = $WT_PATH`.
3. Send exactly one initial message:
   ```text
   # Linear
   $orch start [ISSUE_ID]

   # GitHub
   $orch start github [OWNER/REPO]#[N]
   ```
4. Record the returned thread ID.

If native thread tools are not available, do not substitute terminal launch. Print the worktree path and exact initial message for each item so the user can paste it into a Codex app thread.

Do not use `codex debug app-server send-message-v2` for workflow automation. Do not use raw `codex app-server` for unattended handoff unless the active client can surface approvals to the user.

### Terminal Harnesses

**Skip if** `harness == codex-app`.

```bash
# Linear
.agents/skills/orch/scripts/open-terminal --tracker linear --harness [HARNESS] [ISSUE_IDS]

# GitHub
.agents/skills/orch/scripts/open-terminal --tracker github --repo [OWNER/REPO] --harness [HARNESS] [NUMBERS]
```

## 3. Return

<output_format>
### Milestone: Handoff Launched

| Field | Value |
|-------|-------|
| Launched | [N] |
| Items | [ITEMS] |
| Mode | [codex-app|terminal|manual] |
| Threads | [THREAD_IDS or none] |
| Worktrees | [WORKTREE_PATHS or none] |
| Monitoring | none |
</output_format>
