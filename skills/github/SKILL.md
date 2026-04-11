---
name: github
description: "GitHub API CLI for PR operations: threads, comments, reviews, CI logs, merging, and cross-PR analysis."
license: MIT
user-invocable: true
metadata:
  author: vanillagreen
  version: "1.0.0"
---

# GitHub Queries

CLI wrapper for GitHub API operations used in PR workflows. Provides structured JSON output, bot account support, and configurable issue ID extraction.

```bash
.agents/skills/github/scripts/github.sh <command> [options]
.agents/skills/github/scripts/github.sh -C <path> <command> [options]  # Run in different directory
```

## Commands

| Command | Purpose |
|---------|---------|
| `pr-data <N> [--actionable]` | Get PR with threads, comments, files. `--actionable`: unresolved non-outdated only. |
| `pr-view [N] [--json FIELDS]` | View PR details (wraps gh pr view) |
| `pr-threads <N> [--unresolved]` | Get thread list/count |
| `pr-review-status <N> [--baseline-ts TS --baseline-threads N]` | Check review state, determine if action needed |
| `pr-list-ready [--all] [--format=safe\|table]` | List PRs ready for merge |
| `pr-list-failing [--all] [--format=safe\|table]` | List PRs with CI failures |
| `pr-create [--title T] [--body B] [--draft] [--dry-run] [--force]` | Create PR as bot. Safety checks: not main, has commits, pushed. `--force` skips checks. |
| `pr-merge <N> [--check\|--force]` | Merge PR. `--check`: JSON readiness output without merging. |
| `pr-cross-check [N...] [--quick\|--verify]` | Cross-PR analysis. `--verify`: full build+test (auto-detects build system). |
| `pr-issue <N> [--format=safe\|text]` | Extract issue ID from PR branch (configurable via `GH_ISSUE_PATTERN`) |
| `ci-logs <N> [--lines N] [--format=safe\|text]` | Get CI failure logs for PR |
| `bot-token [--format=safe\|text]` | Check if bot token is configured |
| `dismiss-review <PR> [--bot\|--user NAME] [--message M]` | Dismiss blocking review |
| `resolve-thread <PRRT_...>` | Mark thread(s) resolved |
| `unresolve-thread <PRRT_...>` | Reopen thread(s) |
| `post-reply <id> <body>` | Reply to review comment |
| `post-comment <PR> <body>` | Post PR-level comment |
| `find-comment <PR> --pattern <regex>` | Find comment by pattern/author |
| `edit-comment <id> <body>` | Edit existing comment |
| `sticky-comment <PR> [--verdict\|--analysis\|--body]` | Get bot sticky comment. `--verdict`: quick pass/fail. `--analysis`: deep recommendation. |

Most commands accept no PR number to auto-detect from the current branch.

### PR Merge Check Output

```json
{"can_merge": true, "issues": [], "warnings": [], "mergeable": "MERGEABLE", "review": "APPROVED"}
```

## Output Formats

| Format | Description | Commands |
|--------|-------------|----------|
| `safe` | DEFAULT. Flat, normalized JSON | All |
| `raw` | Original API structure | pr-data, pr-threads |
| `text` | Plain text extraction | pr-issue, ci-logs, bot-token |
| `table` | Human-readable table | pr-list-ready, pr-list-failing |

`--json` is accepted as alias for `--format=safe`.

## Configuration

| Variable | Purpose | Default |
|----------|---------|---------|
| `GH_BOT_TOKEN` | Bot account GitHub token (in `.env.local`) | Falls back to `gh` auth |
| `GH_BOT_USERNAME` | Bot username for review/comment filtering | `review-bot[bot]` |
| `GH_ISSUE_PATTERN` | Regex for issue ID extraction from branches | `[A-Z]+-[0-9]+` |

Bot token supports direct tokens (`ghp_*`, `gho_*`, `ghs_*`, `ghr_*`, `github_pat_*`) and 1Password references (`op://vault/item/field`).

## Error Handling

- Returns `{"error": "message"}` on stderr with exit code 1
- Automatic retry on rate limiting (3 attempts with backoff)
- NOT_FOUND errors return clean `{"error": "Not found"}`

## Troubleshooting

**`Expected VAR_SIGN, actual: UNKNOWN_CHAR`**: Use multi-line GraphQL + `-F` for variables (shell escaping issue with `$` in single-line queries).

## Dependencies

- `gh` CLI (authenticated)
- `jq`
- `op` CLI (optional, 1Password token references)
