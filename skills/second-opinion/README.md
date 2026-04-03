# Second Opinion

Cross-model code review and consultation via external AI CLI. Auto-detects your current harness and calls the opposite — Claude calls Codex, Codex calls Claude.

## Structure

```
skills/second-opinion/
├── SKILL.md          # Agent-facing skill definition + prompt templates
├── README.md         # This file (human setup guide)
└── scripts/
    └── second-opinion  # CLI wrapper (harness detection, invocation, JSON extraction)
```

## Prerequisites

- **jq** installed
- At least one external CLI available: `claude` (Claude Code) or `codex` (Codex CLI)
- Both CLIs should be authenticated before first use

## Usage

From an AI agent (user-invocable slash command):

```
/second-opinion review                  # Review pending changes
/second-opinion challenge <description> # Adversarial analysis of an approach
/second-opinion audit <path>            # Deep examination of existing code
/second-opinion quick <question>        # Quick question to the other model
```

From the shell directly:

```bash
# Review current branch vs main
./scripts/second-opinion review --cwd .

# Detect which CLI would be called
./scripts/second-opinion detect

# Challenge an approach with a prompt file
./scripts/second-opinion challenge --prompt /tmp/my-approach.md

# Override target
./scripts/second-opinion review --target claude --cwd .
```

## Configuration

Set in `.env.local` at project root (see `.env.local.example`). All optional — defaults work out of the box.

| Variable | Default | Purpose |
|----------|---------|---------|
| `SECOND_OPINION_TARGET` | auto-detect | Force target: `claude` or `codex` |
| `SECOND_OPINION_TIMEOUT` | `300` | Max seconds to wait |
| `SECOND_OPINION_CLAUDE_CMD` | (see below) | Full claude command with all flags |
| `SECOND_OPINION_CODEX_CMD` | (see below) | Full codex command with all flags |

### Default commands

```bash
# When calling Claude (from Codex):
SECOND_OPINION_CLAUDE_CMD="claude -p --bare --no-session-persistence --model opus --effort max --allowedTools Bash(read-only:true),Read,Glob,Grep"

# When calling Codex (from Claude):
SECOND_OPINION_CODEX_CMD="codex exec -m gpt-5.4 -s read-only -c model_reasoning_effort=xhigh --ephemeral"
```

To customize, uncomment the relevant line in `.env.local` and edit any flags. The entire variable is the command — no additional flags are appended.

### Flag reference

**Claude flags:**

| Flag | Purpose |
|------|---------|
| `-p` | Non-interactive print mode |
| `--bare` | Skip hooks, LSP, CLAUDE.md discovery |
| `--no-session-persistence` | Ephemeral session |
| `--model opus` | Opus 4.6 (change to `sonnet` or `haiku` for speed/cost) |
| `--effort max` | Max reasoning (`low`, `medium`, `high`, `max`) |
| `--allowedTools` | Tool access (read-only bash, file reads, search) |

**Codex flags:**

| Flag | Purpose |
|------|---------|
| `-m gpt-5.4` | Model (change to any supported model) |
| `-s read-only` | Sandbox mode (`read-only`, `workspace-write`) |
| `-c model_reasoning_effort=xhigh` | Reasoning effort (`low`, `medium`, `high`, `xhigh`) |
| `--ephemeral` | Ephemeral session |

## Integration with review-pr

When the orchestration skill runs `review-pr`, it optionally offers an external review at section 2.1. The user is prompted, and if accepted, the script runs and produces a review-finding JSON that flows through the same pipeline as internal review agents.
