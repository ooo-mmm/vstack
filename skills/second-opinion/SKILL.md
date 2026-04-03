---
name: second-opinion
description: "Cross-model second opinion: review, challenge, audit, and consult via an external AI CLI (Claude ↔ Codex)."
license: MIT
user-invocable: true
argument-hint: "review [--range <base..head>] | challenge <description> | audit <path> | quick <question>"
metadata:
  author: vanillagreen
  version: "1.0.0"
---

# Second Opinion

Cross-model second opinion via external AI CLI. Auto-detects the current harness and calls the opposite:

| Running in | Calls |
|------------|-------|
| Claude Code | Codex |
| Codex | Claude |
| Other / unknown | Whichever CLI is available |

Override with `SECOND_OPINION_TARGET=claude|codex` in `.env.local`.

```bash
.agents/skills/second-opinion/scripts/second-opinion <mode> [options]
```

## Commands

| Command | Description | Output |
|---------|-------------|--------|
| `review` | Code review of pending changes | Review finding JSON |
| `challenge` | Adversarial analysis of an approach | Structured critique (text) |
| `audit` | Deep examination of existing code | Review finding JSON |
| `quick` | Quick question to the other model | Text response |
| `detect` | Print the auto-detected target CLI | Target name |

## Common Options

All modes accept:

| Flag | Description |
|------|-------------|
| `--target <name>` | Override target: `claude` or `codex` |
| `--cwd <path>` | Working directory for external CLI (default: `.`) |
| `--timeout <secs>` | CLI timeout in seconds (default: 300) |
| `--output <path>` | Write result to file (review/audit modes) |
| `--prompt <file>` | Prompt file (challenge/audit/quick modes) |

---

## Review

Review pending changes against the base branch. The script auto-generates the review prompt with an embedded schema — no custom prompt needed.

### Usage

```bash
# Review full PR diff (auto-detects base branch)
.agents/skills/second-opinion/scripts/second-opinion review \
  --cwd [WORKTREE_PATH] \
  --output [WORKTREE_PATH]/tmp/review-external-YYYYMMDD-HHMMSS.json

# Review specific commit range
.agents/skills/second-opinion/scripts/second-opinion review \
  --range [BASE_SHA]..[HEAD_SHA] \
  --cwd [WORKTREE_PATH] \
  --output [OUTPUT_PATH]
```

### Workflow

1. If user says `/second-opinion review` with no extra context → run the script with `--cwd` set to the project root.
2. If user specifies a commit range → pass `--range`.
3. If user specifies a PR number → resolve the worktree path first, then pass `--cwd`.
4. Present the JSON result: verdict, blockers table, suggestions table.
5. If `action_required` → ask user which items to address.

### Output

Standard review-finding JSON — same schema used by all internal review agents:

```json
{
  "agent": "external-[TARGET]",
  "timestamp": "2026-01-14T03:30:00Z",
  "verdict": "pass|action_required",
  "summary": "1-2 sentence summary",
  "blockers": [],
  "suggestions": [],
  "questions": [],
  "qa_metadata": {}
}
```

`questions` is always empty for external reviews (no PR comment context). `qa_metadata` is always empty (no benchmark data).

---

## Challenge

Adversarial analysis of a proposed approach before implementation.

### Workflow

1. Gather the user's description of their approach.
2. Read relevant code files for context.
3. Write a prompt file to `tmp/second-opinion-prompt.md`:

<prompt_template>
You are an adversarial reviewer providing a cross-model second opinion. The developer wants to take the following approach — your job is to stress-test it.

**Proposed approach:**
[USER_DESCRIPTION]

**Relevant code:**
[CODE_SNIPPETS — include file paths as headers]

Analyze thoroughly:
1. **Risks** — What could go wrong? Failure modes, data loss scenarios, security implications.
2. **Edge cases** — What inputs, states, or timing conditions are unhandled?
3. **Alternatives** — What other approaches exist? Include concrete trade-offs.
4. **Assumptions** — What is the developer assuming that might not hold?

Be specific — reference actual code paths, function names, and behaviors. No vague warnings.

Structure your response exactly as:

## Risks
[numbered list with severity: CRITICAL / HIGH / MEDIUM / LOW]

## Edge Cases
[numbered list — describe the scenario AND what would happen]

## Alternatives
[numbered list — each with: approach, trade-off, when to prefer it]

## Verdict
[1-2 sentences: PROCEED (approach is sound), RECONSIDER (fixable concerns), or STOP (fundamental flaw)]
</prompt_template>

4. Call the script:
```bash
.agents/skills/second-opinion/scripts/second-opinion challenge \
  --prompt tmp/second-opinion-prompt.md \
  --cwd [PROJECT_PATH]
```

5. Present the response to the user. Highlight any CRITICAL or HIGH severity risks.

---

## Audit

Deep examination of existing code — not changes, but the code as it is. Returns review-finding JSON.

### Workflow

1. Identify target files/directories from user request.
2. Read the code to understand scope — build a file list.
3. Write a prompt file to `tmp/second-opinion-prompt.md`:

<prompt_template>
You are a code auditor providing a cross-model second opinion. Examine the specified code for quality issues.

**Files to audit:**
[FILE_LIST — one per line]

Read each file. Focus on:
- Bugs and logic errors
- Security vulnerabilities (injection, auth bypass, data exposure)
- Race conditions and concurrency issues
- Resource leaks (file handles, connections, memory)
- Error handling gaps (silent failures, swallowed errors)
- Design problems (tight coupling, broken abstractions)

Skip: style preferences, naming opinions, documentation gaps.

Output ONLY valid JSON — no markdown fences, no explanation before or after:

{
  "agent": "external-[TARGET]",
  "timestamp": "[ISO_8601]",
  "verdict": "pass or action_required",
  "summary": "1-2 sentence summary of findings",
  "blockers": [
    {
      "id": 1,
      "title": "Concise issue title (5-10 words)",
      "location": "src/file.rs (`function_name`)",
      "description": "What the issue is",
      "recommendation": "How to fix it",
      "priority": 1,
      "estimate": 2
    }
  ],
  "suggestions": [
    {
      "id": 1,
      "title": "Concise issue title (5-10 words)",
      "location": "src/file.rs (`function_name`)",
      "description": "What could be improved",
      "recommendation": "How to improve it",
      "priority": 3,
      "estimate": 2,
      "category": "fix"
    }
  ],
  "questions": [],
  "qa_metadata": {}
}

Rules:
- verdict: "action_required" if 1+ items in blockers[], "pass" if blockers[] is empty
- location: file path with function/struct names in backticks — NO line numbers
- priority: 1=Urgent, 2=High, 3=Normal, 4=Low
- estimate: 1=hours, 2=half-day, 3=day, 4=2-3 days, 5=week+
- category: "fix" (apply in this PR) or "issue" (track separately)
- Only report genuine issues — no filler
</prompt_template>

4. Call the script:
```bash
.agents/skills/second-opinion/scripts/second-opinion audit \
  --prompt tmp/second-opinion-prompt.md \
  --cwd [PROJECT_PATH] \
  --output tmp/audit-external-YYYYMMDD-HHMMSS.json
```

5. Present findings to the user: verdict, blockers table, suggestions table.

---

## Quick

Lightweight question to the other model. No structured output format.

### Workflow

1. Gather the user's question.
2. Optionally read relevant files for context.
3. Write a prompt file to `tmp/second-opinion-prompt.md`:

<prompt_template>
[QUESTION]

[If relevant files were identified:]
For context, read these files:
[FILE_LIST — one per line]

Answer concisely and directly. If you need to examine code in this project to answer, do so. Focus on what's practically useful — no hedging or disclaimers.
</prompt_template>

4. Call the script:
```bash
.agents/skills/second-opinion/scripts/second-opinion quick \
  --prompt tmp/second-opinion-prompt.md \
  --cwd [PROJECT_PATH]
```

5. Present the response to the user verbatim.

---

## Configuration

Set in `.env.local` (or `.env` as fallback) at project root — the script sources it automatically.

| Variable | Default | Description |
|----------|---------|-------------|
| `SECOND_OPINION_TARGET` | auto-detect | Force target CLI: `claude` or `codex` |
| `SECOND_OPINION_TIMEOUT` | `300` | CLI timeout in seconds |
| `SECOND_OPINION_CLAUDE_CMD` | (see below) | Full `claude` command — all flags |
| `SECOND_OPINION_CODEX_CMD` | (see below) | Full `codex` command — all flags |

### Default commands

**Claude** (called when running from Codex):
```bash
SECOND_OPINION_CLAUDE_CMD="claude -p --bare --no-session-persistence --model opus --effort max --allowedTools Bash(read-only:true),Read,Glob,Grep"
```

| Flag | Purpose |
|------|---------|
| `-p` | Print mode — non-interactive, single response |
| `--bare` | Skip hooks, LSP, CLAUDE.md — clean independent review |
| `--no-session-persistence` | Don't save session to disk |
| `--model opus` | Claude Opus 4.6 |
| `--effort max` | Maximum reasoning effort |
| `--allowedTools ...` | Read-only bash, file reads, search — no writes |

**Codex** (called when running from Claude):
```bash
SECOND_OPINION_CODEX_CMD="codex exec -m gpt-5.4 -s read-only -c model_reasoning_effort=xhigh --ephemeral"
```

| Flag | Purpose |
|------|---------|
| `exec` | Non-interactive execution mode |
| `-m gpt-5.4` | GPT-5.4 model |
| `-s read-only` | Read-only sandbox — no file modifications |
| `-c model_reasoning_effort=xhigh` | Maximum reasoning effort |
| `--ephemeral` | Don't persist session to disk |

To customize, copy the full command into `.env.local` and edit any flags. The entire variable is used as-is — the script does not append additional flags.

## Error Handling

On script failure (non-zero exit), stderr contains a JSON error object:

```json
{"error": "description", "target": "codex"}
```

| Exit code | Meaning | Action |
|-----------|---------|--------|
| 1 | CLI not found, missing prompt, invalid JSON response | Report error to user, suggest checking CLI installation |
| 124 | Timeout (default 300s) | Report timeout, suggest `--timeout` increase or narrower `--range` |

If the script fails during the `review-pr` workflow, **continue** — external review is advisory.

## Presenting Results

### For review/audit modes (JSON output)

<output_format>

### External Review — [TARGET]

| Verdict | Agent | Summary |
|---------|-------|---------|
| ✅ pass / ⚠️ action_required | external-[TARGET] | [SUMMARY] |

**Blockers**

| # | Location | Description | Pri |
|---|----------|-------------|-----|
| [id] | [location] | [description] | 🔴 |

**Suggestions**

| # | Location | Description | Cat | Pri |
|---|----------|-------------|-----|-----|
| [id] | [location] | [description] | fix/issue | 🟡 |

</output_format>

Omit empty sections.

### For challenge mode (text output)

Present the structured response directly. Highlight CRITICAL/HIGH risks with emphasis.

### For quick mode (text output)

Present the response directly — no additional framing.
