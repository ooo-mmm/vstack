# Orchestration

Primary-agent, single work-item orchestration for Linear and GitHub issues.

## Commands

Invoke via your AI coding harness (e.g., `/orch <command>` or `/skill:orch <command>`).

| Command | Description |
|---------|-------------|
| `start [ISSUE_ID]` | Prepare/start one Linear issue |
| `start github OWNER/REPO#N` | Prepare/start one GitHub issue |
| `start new linear\|github ...` | Create one issue, then start it |
| `handoff linear\|github ...` | Launch worktree sessions only; no monitoring |
| `plan-issues PLAN_PATH linear\|github` | Convert plan items into tracker issues |
| `dev-start [ISSUE_ID]` | Delegate implementation to specialist agents |
| `dev-fix [ISSUE_ID]` | Delegate review fix items |
| `ci-fix PR_NUMBER \| queue` | Fix CI failures |
| `review [all \| last N \| HASH]` | On-demand code review |
| `review-codebase [PATH]` | Whole-codebase reviewer fanout |
| `review-pr [PR_NUMBER]` | Pre-submission review |
| `review-pr-comments PR_NUMBER` | Triage PR review comments |
| `submit-pr [PR_NUMBER]` | Push, create PR, bot review, CI |
| `merge-pr PR_NUMBER \| all` | Verify and merge PR(s) |
| `parallel-check [ISSUE_IDS]` | Verify parallel work safety |

## Skill Dependencies

| Skill | Purpose |
|-------|---------|
| `linear` | Linear issue tracking (CRUD, cache, comments) |
| `github` | PR operations, CI status |
| `worktree` | Git worktree management |
| `project-management` | TPM audit/cycle/roadmap workflows |
| `decider` | Architectural decision documents |

## Setup

1. Install dependency skills: `github`, `worktree`, `decider`, `project-management`; add `linear` for Linear workflows.
2. Set runtime config in `.env` or `.env.local`.
3. Verify each skill works from the project root before invoking a workflow.

## Configuration

Set in `.env` or `.env.local` (`.env.local` wins). Helper scripts source both automatically.

| Variable | Purpose | Default |
|----------|---------|---------|
| `ORCH_STATE_DIR` | State file directory | `tmp` |
| `ORCH_CACHE_DIR` | Parallel-group safety cache | `.cache/orch` |
| `GH_TOKEN` | Main/user GitHub token | current `gh` auth |
| `GH_BOT_TOKEN` | Bot GitHub token for worktree auth | current `gh` auth |
| `GH_ISSUE_PATTERN` | Issue ID regex for branch names | `[A-Z]+-[0-9]+` |
| `BOT_REVIEWERS` | Comma-separated review bot usernames | auto-detect |
| `BOT_CHECK_NAME` | CI check name for early review detection | — |

See [`DEVELOPMENT.md`](./DEVELOPMENT.md) for GitHub auth fallback details and the test runner.

## System Dependencies

- `jq`, `bash` 4+, `flock` (util-linux)

## Codex Desktop Worktrees

For app-visible handoff, use `handoff ... --harness codex-app` from the orch workflow. The Codex app branch creates/reuses the vstack worktree, then uses native Codex app thread-management tools when the runtime exposes them. If those tools are absent, it prints the worktree path and exact `$orch start ...` message for manual app-thread launch.

Let Codex Desktop own Codex-managed worktree creation, branch metadata, and teardown when using its built-in worktree mode. Configure the worktree skill's `codex-setup` and `codex-cleanup` hooks in the Codex environment, then run `initialize [ISSUE_ID]` or `start [ISSUE_ID]` with an explicit issue ID.

Do not automate app-visible handoff with `codex debug app-server send-message-v2`. Do not run raw `codex app-server` unattended unless the active client can surface approvals to the user.
