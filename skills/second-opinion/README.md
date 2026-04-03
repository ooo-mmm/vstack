# Second Opinion

Cross-model code review and consultation via external AI CLI. Auto-detects your current harness and calls the opposite — Claude calls Codex, Codex calls Claude.

## Structure

```
skills/second-opinion/
├── SKILL.md                    # Agent-facing routing table + config
├── README.md                   # This file
├── schemas/
│   └── review-finding-prompt.md  # JSON schema (shared by review + audit)
├── scripts/
│   └── second-opinion          # CLI wrapper
└── workflows/
    ├── review.md               # Code review → JSON
    ├── challenge.md            # Adversarial analysis → text
    ├── audit.md                # Code examination → JSON
    └── quick.md                # Quick question → text
```

## Prerequisites

- **jq** installed
- At least one external CLI: `claude` (Claude Code) or `codex` (Codex CLI)
- CLI must be authenticated (`claude /login` or `codex login`)

## Usage

As a slash command (natural language works):

```
/second-opinion review                     # Full branch diff
/second-opinion review last 3 commits      # Recent commits only
/second-opinion review uncommitted work     # Staged/unstaged changes
/second-opinion challenge my refactor plan  # Stress-test an approach
/second-opinion audit src/auth/             # Examine existing code
/second-opinion quick is this pattern safe? # Quick question
```

From the shell:

```bash
./scripts/second-opinion review --cwd .
./scripts/second-opinion detect
./scripts/second-opinion review --target claude --range HEAD~3..HEAD --cwd .
```

## Configuration

All optional — defaults work out of the box. Set in `.env.local` at project root (see `.env.local.example` for full flag reference).

| Variable | Default | Purpose |
|----------|---------|---------|
| `SECOND_OPINION_TARGET` | auto-detect | Force target: `claude` or `codex` |
| `SECOND_OPINION_TIMEOUT` | `300` | Max seconds to wait |
| `SECOND_OPINION_CLAUDE_CMD` | `claude -p --no-session-persistence --model opus --effort max --allowedTools ...` | Full command when calling Claude |
| `SECOND_OPINION_CODEX_CMD` | `codex exec -m gpt-5.4 -s read-only -c model_reasoning_effort=xhigh --ephemeral` | Full command when calling Codex |

Edit the full command string to change model, effort level, or tool access. No additional flags are appended.

## review-pr Integration

The orchestration skill's `review-pr` workflow optionally offers an external review at § 2.1. If accepted, the script produces review-finding JSON (same schema as internal review agents) that flows through the standard blocker/suggestion/issue pipeline.
