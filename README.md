# vstack

Cross-harness package manager for AI coding systems.

Write a package once as a harness-agnostic skill, agent, or hook, then install it into Claude Code, Cursor, OpenCode, Codex, or Pi through one Rust CLI.

[![Rust](https://img.shields.io/badge/Rust-%20-000000?style=flat-square&logo=rust)](./cli/Cargo.toml)
[![Ratatui](https://img.shields.io/badge/TUI-ratatui-5D3FD3?style=flat-square)](https://ratatui.rs)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-supported-0EA5E9?style=flat-square)](#supported-harnesses)
[![Cursor](https://img.shields.io/badge/Cursor-supported-0EA5E9?style=flat-square)](#supported-harnesses)
[![OpenCode](https://img.shields.io/badge/OpenCode-supported-0EA5E9?style=flat-square)](#supported-harnesses)
[![Codex](https://img.shields.io/badge/Codex-supported-0EA5E9?style=flat-square)](#supported-harnesses)
[![Pi](https://img.shields.io/badge/Pi-supported-0EA5E9?style=flat-square)](#supported-harnesses)

![vstack TUI](docs/assets/vstack-tui.png)

---

## What Is vstack?

`vstack` is two things:

1. A Rust CLI and TUI for discovering, selecting, installing, updating, and removing AI coding packages.
2. A maintained package catalog in this repo containing reusable agents, skills, and hooks.

The key idea is simple:

- Packages are authored once in canonical, harness-agnostic formats.
- `vstack` translates them into each harness's native representation at install time.
- Repos can be swapped. The built-in catalog is just the default source, not the only one.

This makes `vstack` closer to a package manager than a static dotfiles repo.

## Features

- **Cross-harness install**: Claude Code, Cursor, OpenCode, Codex, and Pi from one CLI.
- **Package source management**: switch between repos, add/remove sources from the TUI.
- **Global and project scope**: install once per user, or per project.
- **Dependency resolution**: skills declare required/optional dependencies in `SKILL.md`; required deps are auto-included transitively.
- **Config-driven attribution**: `vstack.toml` maps extra skills to agents, role-wide skills to agent roles, and hook events to roles.
- **Project customization**: per-agent guidance, instructions, custom skills, per-skill instructions, and custom hooks via project-level `vstack.toml` — survives upstream updates.
- **Reconciliation**: installed agents and skills regenerate when packages change, preserving user edits.
- **`vstack refresh`**: regenerate all agent files and re-inject project skill instructions after editing `vstack.toml`.
- **Version-based update check**: notifies when the CLI version changes, not on every repo push. `vstack update --force` to rebuild from source.
- **Source registry**: previously used package repos are remembered and reusable from the TUI.
- **Fast terminal UX**: native Rust TUI with mouse support, built with `ratatui` and `crossterm`.

## Quick Start

```bash
# Install the CLI
cargo install --git https://github.com/vanillagreencom/vstack.git vstack

# Open the interactive installer with the default package catalog
vstack add vanillagreencom/vstack
```

## Project-Local Config

Two config files live at the project root:

- **`vstack.toml`** — agent customization (guidance, instructions, custom skills, custom hooks). Auto-created on first install. Edit and run `vstack refresh` to apply. See [Project Customization](#project-customization).
- **`.env.local`** — workflow config for skills that need it (worktree behavior, issue-tracker tokens, bot auth). Copy [.env.local.example](./.env.local.example) and fill only the variables your project uses. The `worktree` skill symlinks this into created worktrees.

## How It Works

### Mental Model

`vstack` treats a source repo as a package registry:

- `agents/*.md`: canonical agent definitions
- `skills/*/SKILL.md`: canonical skills, rules, scripts, workflows
- `hooks/*.sh`: canonical safety hooks
- `pi-extensions/*/package.json`: optional npm-shaped Pi extension packages
- `vstack.toml`: mapping and attribution rules

At install time, the CLI discovers those packages, lets the user choose what to install, then emits harness-specific files in the correct destination.

### Dependencies And Mapping

Package dependencies are currently skill-to-skill dependencies. A skill can declare them in `SKILL.md` frontmatter:

```yaml
dependencies:
  required: [linear, orchestration, decider]
  optional: []
```

`vstack` builds a dependency graph from installed skills and auto-adds only `required` dependencies. `optional` dependencies are preserved as metadata/documentation, but are not auto-installed.

`vstack.toml` in the source repo is the mapping layer. `[agent-skills]` is the single source of truth for which skills appear in each agent's frontmatter — when an agent has an explicit entry, prefix matching is skipped. `[role-skills]` adds skills to all agents of a role. `[hook-events]` assigns hooks by event/matcher to roles.

```toml
[agent-skills]
rust = ["rust-arch", "rust-async", "rust-cargo", "rust-conventions", "rust-cross", "rust-debugging", "rust-ffi", "rust-no-std", "rust-safety"]
iced = ["iced-rs", "iced-shadcn", "trading-design", "price-handling"]

[role-skills]
engineer = ["issue-lifecycle", "github", "worktree", "decider", "linear"]
reviewer = ["issue-lifecycle", "linear"]

[hook-events]
"PreToolUse:Bash" = "all"
"PostToolUse:Edit|Write" = ["engineer"]
```

### Project Customization

`vstack add` auto-creates a `vstack.toml` at your project root with commented placeholders for every installed agent and skill. Edit the values, then run `vstack refresh` to apply.

All sections survive upstream updates — they're re-applied from the config on every install and refresh.

```toml
# What the agent should do when first invoked
[agent-launch-instructions]
rust = "Read open issues and begin working on the highest-priority backend task."
generalist = ""    # empty = no section generated

# Project-specific rules appended to the bottom of agent files
[agent-additional-instructions]
rust = "Always run clippy before committing."

# Skills attached to each agent's frontmatter — single source of truth.
# Populated automatically at install time. Add your own skills to any
# agent's list; remove skills you don't want. Run `vstack refresh` to apply.
[agent-skills]
rust = ["rust-arch", "rust-async", "rust-cargo", "rust-conventions", "rust-cross", "rust-debugging", "rust-ffi", "rust-no-std", "rust-safety", "decider", "github", "issue-lifecycle", "linear", "worktree"]
iced = ["iced-rs", "iced-shadcn", "trading-design", "price-handling", "decider", "github", "issue-lifecycle", "linear", "worktree"]

# Project instructions appended at the bottom of each skill's SKILL.md (won't overwrite the skill author's own)
[skill-instructions]
trading-design = "Focus on dark theme with green/red accent colors."

# Project-local hooks (Claude Code runs the command; other harnesses get the description as inline instructions)
[[custom-hooks]]
event = "PreToolUse"
matcher = "Bash"
command = "./scripts/no-force-push.sh"
description = "Never run git push --force on main or master."
agents = "all"     # "all", a role ("engineer"), or a list ["rust", "iced"]
```

If you edit a generated agent or skill file directly (e.g., add an "Additional Instructions" section), vstack extracts your edits and saves them to `vstack.toml` before the next regeneration — so both approaches work.

### Skill Instructions

Project-specific skill guidance lives in the project root `vstack.toml` under `[skill-instructions]`. vstack injects that text into the installed `SKILL.md` during `vstack add` and `vstack refresh`, so project guidance survives upstream package updates without editing source skills directly.

### Architecture

```text
source repo
├─ agents/*.md
├─ skills/*/SKILL.md
├─ hooks/*.sh
└─ vstack.toml
        │
        ▼
   vstack CLI / TUI
   - discovers packages
   - resolves dependencies
   - selects repo / scope / harnesses / method
   - applies mapping rules
        │
        ├─ Claude Code → .claude/agents, .claude/skills, .claude/hooks, settings.json
        ├─ Cursor      → .cursor/rules
        ├─ OpenCode    → .opencode/agents, .opencode/skills, opencode.json
        ├─ Codex       → .codex/agents, .agents/skills
        └─ Pi          → .pi/agents, .agents/skills, .pi/packages, .pi/settings.json
```

### Repo Sources

The default source is this repo: `vanillagreencom/vstack`.

The TUI also supports:

- switching between remembered package repos
- adding a new package repo by GitHub shorthand or URL
- persisting known sources in a small registry under vstack's global state

Compatible repos follow the same content model:

```text
agents/
skills/
hooks/
pi-extensions/
vstack.toml
```

`pi-extensions/` is optional — only include it if your repo ships Pi extension packages.

## Supported Harnesses

| Harness | Agents | Skills | Hooks | Notes |
|---|---|---|---|---|
| Claude Code | `.claude/agents/*.md` | `.claude/skills/<name>/` | native `.claude/hooks/*.sh` + `settings.json` | richest native hook support |
| Cursor | `.cursor/rules/*.mdc` | `.cursor/rules/<name>/` | safety rules only | project scope only |
| OpenCode | `.opencode/agents/*.md` | `.opencode/skills/<name>/` | instructions + `opencode.json` permissions | config-dir aware |
| Codex | `.codex/agents/*.toml` | `.agents/skills/<name>/` | safety prose in `developer_instructions` | uses `CODEX_HOME` when set |
| Pi | `.pi/agents/*.md` | `.agents/skills/<name>/` | safety prose in agent body | extensions install to `.pi/packages/<name>` and register in `.pi/settings.json` |

Global install behavior:

- Claude Code: user home `~/.claude`
- OpenCode: config-dir based, respecting `OPENCODE_CONFIG` / `OPENCODE_CONFIG_DIR`
- Codex: `CODEX_HOME` or `~/.codex`
- Pi: `~/.pi/agent`, respecting `PI_CODING_AGENT_DIR`
- Cursor: intentionally project-only

### Pi notes

- **Agents.** Pi has no built-in subagent mechanism, so `.pi/agents/*.md` files are inert until a loader extension is installed. `pi-subagents-tmux` provides that loader; `pi-session-bridge` is a separate TUI side-channel for external controllers.
- **Hooks.** No native Pi hook runtime, so safety hook prose is appended to the agent body instead of running as commands.
- **Extensions.** `vstack add` copies the package into `<scope>/packages/<name>`, registers `./packages/<name>` in that scope's `settings.json` (preserving unrelated entries), and symlinks each `package.json` `bin` entry to `<scope>/bin/<cli-name>`. Add `<scope>/bin` to `PATH` for bare-name invocation. `vstack remove` cleans all three.
- **Extension scope is exclusive.** Pi loads global + project scopes simultaneously, so duplicate registration would crash startup. Installing into one scope when the other already has it is skipped with a notice — `vstack remove [--global]` first to switch.

Windows note:

- The CLI should run natively.
- “Symlink” mode falls back to copy on non-Unix targets.

## Package Catalog In This Repo

### Agents

| Agent | Role | Brief |
|---|---|---|
| `generalist` | engineer | General maintenance, cleanup, docs, stale references, and project hygiene. |
| `iced` | engineer | Iced UI implementation and architecture specialist. |
| `researcher` | engineer | Exa-powered research specialist for evidence-backed findings reports. |
| `rust` | engineer | Rust engineer for systems work, performance, zero-allocation, and low-level design. |
| `tpm` | manager | Technical program management and roadmap analysis agent. |
| `reviewer-arch` | reviewer | Reviews boundaries, abstractions, and architectural drift. |
| `reviewer-doc` | reviewer | Reviews documentation accuracy and stale docs. |
| `reviewer-error` | reviewer | Reviews error handling, silent failures, and propagation. |
| `reviewer-perf` | reviewer | Reviews latency, benchmarks, and performance regressions. |
| `reviewer-safety` | reviewer | Reviews unsafe Rust, memory safety, and concurrency correctness. |
| `reviewer-security` | reviewer | Reviews auth, input handling, and security risks. |
| `reviewer-structure` | reviewer | Reviews modularity, file size, and code organization. |
| `reviewer-test` | reviewer | Reviews test coverage, missing cases, and test quality. |

### Skills

Each skill name links to its skill directory (GitHub renders `README.md` when present; otherwise the file list shows `SKILL.md`). `*` marks skills that need project-local setup before first use (`.env.local`, decision directories, or command aliases) — see that skill's `README.md` for bootstrap steps.

#### Rust

| Skill | Brief |
|---|---|
| [`rust-arch`](skills/rust-arch/) | Rust architecture rules, anti-patterns, and review heuristics. |
| [`rust-async`](skills/rust-async/) | Async internals, runtime patterns, cancellation, and concurrency composition. |
| [`rust-cargo`](skills/rust-cargo/) | Cargo workflows, workspaces, feature flags, and build/release config. |
| [`rust-conventions`](skills/rust-conventions/) | Style, layout, tests, and definition-of-done conventions. |
| [`rust-cross`](skills/rust-cross/) | Cross-compilation, target setup, and multi-platform builds. |
| [`rust-debugging`](skills/rust-debugging/) | GDB/LLDB, tracing, panic triage, and async runtime debugging. |
| [`rust-ffi`](skills/rust-ffi/) | Safe C interop and FFI wrapper patterns. |
| [`rust-no-std`](skills/rust-no-std/) | `no_std` design, alloc boundaries, and embedded-friendly structure. |
| [`rust-safety`](skills/rust-safety/) | Unsafe code review, SAFETY comments, and safety audit patterns. |

#### Performance

| Skill | Brief |
|---|---|
| [`perf-cache`](skills/perf-cache/) | Cache locality, false sharing, and data layout optimization. |
| [`perf-ebpf`](skills/perf-ebpf/) | Aya/eBPF instrumentation and kernel-level observability. |
| [`perf-latency`](skills/perf-latency/) | Benchmarking and percentile-focused latency measurement. |
| [`perf-lock-free`](skills/perf-lock-free/) | Atomics, loom verification, and lock-free correctness. |
| [`perf-profiling`](skills/perf-profiling/) | Flamegraphs, hotspot analysis, NUMA, and jitter investigation. |
| [`perf-simd`](skills/perf-simd/) | SIMD, auto-vectorization, intrinsics, and runtime dispatch. |
| [`perf-threading`](skills/perf-threading/) | Pinning, topology-aware concurrency, and jitter reduction. |
| [`perf-zero-alloc`](skills/perf-zero-alloc/) | Eliminating allocations in hot paths. |

#### UI / Domain

| Skill | Brief |
|---|---|
| [`iced-rs`](skills/iced-rs/) | Iced 0.14 patterns, reactive UI rules, and Elm-style structure. |
| [`iced-shadcn`](skills/iced-shadcn/) | shadcn Base UI component planning, family decomposition, and parity audits for Iced. |
| [`price-handling`](skills/price-handling/) | Price rounding, epsilon comparison, and market-price handling. |
| [`trading-design`](skills/trading-design/) | Dense, professional trading-style interface design guidance. |

#### Workflow / Platform

| Skill | Brief | Commands |
|---|---|---|
| [`decider`](skills/decider/)* | Architectural decision document management and indexing. | — |
| [`deep-research`](skills/deep-research/) | Exa-powered deep research and portable findings report generation. | `scripts/deep-research report "question" --output findings.md`, `scripts/deep-research doctor` |
| [`github`](skills/github/)* | GitHub PR, thread, review, CI, and merge workflows. | — |
| [`issue-lifecycle`](skills/issue-lifecycle/)* | Delegated implementation/review/QA issue workflows. | — |
| [`linear`](skills/linear/)* | Linear issue, cycle, milestone, and project workflows. | — |
| [`flightdeck`](skills/flightdeck/)* | Master session lifecycle for multi-issue parallel dev work; tmux-only. | `/flightdeck start [ISSUE_ID]`, `/flightdeck parallel-check`, `/flightdeck watch`, `/flightdeck status` |
| [`orchestration`](skills/orchestration/)* | Per-issue inside-worktree lifecycle: dev → review → submit → merge. | `/orchestration start`, `/orchestration dev-start`, `/orchestration ci-fix`, `/orchestration review-pr`, `/orchestration submit-pr`, `/orchestration merge-pr` |
| [`project-management`](skills/project-management/)* | TPM-orchestrated planning, audit, roadmap, research-driven decomposition. | `/project-management cycle-plan`, `/project-management audit-issues`, `/project-management roadmap plan`, `/project-management roadmap create`, `/project-management research-spike`, `/project-management research-complete` |
| [`second-opinion`](skills/second-opinion/) | Cross-model review via external AI CLI; auto-detects harness and calls the opposite (Claude ↔ Codex). | `/second-opinion review`, `/second-opinion challenge`, `/second-opinion audit`, `/second-opinion quick` |
| [`worktree`](skills/worktree/)* | Git worktree creation, env/config linkage, and isolated workflows. | `/worktree create`, `/worktree list`, `/worktree remove`, `/worktree push`, `/worktree check` |

### Hooks

| Hook | Event | Brief |
|---|---|---|
| `block-bare-cd` | `PreToolUse` | Blocks unsafe bare `cd` usage and nudges toward subshell-safe patterns. |
| `pre-commit-check` | `PreToolUse` | Validates formatting and lint before commits. |
| `post-edit-lint` | `PostToolUse` | Runs lint checks after source edits. |
| `task-completed-check` | `TaskCompleted` | Runs final lint checks before marking work complete. |

### Pi Extensions

All vstack Pi packages declare `vstack.extensionManager.settings` metadata, including an `enabled` feature toggle. Install `pi-extension-manager` to browse inventory, toggle resources, and edit those settings from Pi. Each extension name links to its `README.md` for the full feature list, settings reference, and behavior notes.

| Extension | Purpose |
|---|---|
| [`pi-extension-manager`](pi-extensions/pi-extension-manager/README.md) | Pi-styled extension inventory, full settings shell, and quick inline settings editor (`/extensions`). |
| [`pi-skills-manager`](pi-extensions/pi-skills-manager/README.md) | Dedicated `/skills` shell for browsing, creating, editing, and toggling Pi skills; expands `[skill] <name>` markers before sending prompts. |
| [`pi-background-tasks`](pi-extensions/pi-background-tasks/README.md) | Non-blocking shell tasks via `bg_task`/`bg_status` plus a `/bg` dashboard so long-running commands do not block the turn. |
| [`pi-questions`](pi-extensions/pi-questions/README.md) | Structured multi-tab popup questions for the model with bridge-driven replies. |
| [`pi-session-bridge`](pi-extensions/session-bridge/README.md) | Unix-socket JSONL side channel + `pi-bridge` CLI for external control, event streaming, prompt sending, and answering `pi-questions`. |
| [`pi-subagents-tmux`](pi-extensions/pi-subagents-tmux/README.md) | Delegate work to `.pi/agents` / `.claude/agents` with isolated context and persistent tmux panes (`subagent`, `get_subagent_result`, `steer_subagent`, `/agents`). |
| [`pi-prompt-stash`](pi-extensions/pi-prompt-stash/README.md) | Per-session prompt stash history with stash/pop editor (`Alt+S`). |
| [`pi-qol`](pi-extensions/pi-qol/README.md) | Compact statusline/`π` prompt, multiline input, image chips, session naming/search/handoff, custom compaction, thinking timer. |
| [`pi-session-manager`](pi-extensions/pi-session-manager/README.md) | Polished session browser (`/sessions`) for searching, resuming, renaming, and deleting Pi sessions. |
| [`pi-codex-minimal-tools`](pi-extensions/pi-codex-minimal-tools/README.md) | Adds Codex-style `view_image`, `apply_patch`, native OpenAI `image_generation` without replacing Pi's native file/shell/edit tools. |
| [`pi-web-tools`](pi-extensions/pi-web-tools/README.md) | First-party web stack: provider-toggled `web_search`, Exa deep research, and `web_fetch` extraction with HTML chrome strip + Jina fallback, GitHub clone cache, scanned-PDF vision OCR, YouTube/local video understanding, and Exa Code `/context` for `code_search`. See also [`EXA.md`](pi-extensions/pi-web-tools/EXA.md). |
| [`pi-output-policy`](pi-extensions/pi-output-policy/README.md) | OMP-style large-output policy: shell minimization, head/tail truncation, spill-file preservation, UI-safe caps. |
| [`pi-tool-renderer`](pi-extensions/pi-tool-renderer/README.md) | Compact Claude/opencode-style renderers for built-in `read`/`bash`/search/mutation tools while preserving original execution. |
| [`pi-task-panel`](pi-extensions/pi-task-panel/README.md) | Persistent structured task panel above the status line plus `/tasks` commands and `tasks_write` tool. |
| [`pi-caveman`](pi-extensions/pi-caveman/README.md) | Native Pi caveman communication mode via `before_agent_start` prompt injection (`/caveman`). |

See also: [Pi extension settings audit](docs/pi-extension-settings-audit.md).

Source layout:

```text
pi-extensions/
└─ <name>/
   ├─ package.json        npm-shaped, with `pi.extensions` and optional `bin`
   ├─ extensions/*.ts     loaded by Pi via the `pi.extensions` manifest
   ├─ bin/*               optional CLI scripts
   ├─ README.md
   └─ THIRD_PARTY_NOTICES.md  optional attribution for vendored/base code
```

Authoring a new Pi extension package: write a `package.json` with `keywords: ["pi-package"]`, `pi.extensions`, and any `bin` scripts. vstack will pick it up automatically the next time you run `vstack add` against a source repo containing it.

Updates: edit files under `pi-extensions/<name>/` in the vstack repo, then run `vstack refresh` (or `vstack add` again) — installed Pi scopes pick up the change. Users never edit the deployed copy directly.

#### Settings layout

vstack writes Pi's `packages` array using the relative form Pi resolves against the settings file directory:

```json
{
  "packages": [
    "./packages/pi-session-bridge",
    "./packages/pi-qol"
  ]
}
```

| Scope | Settings file | Packages directory |
|---|---|---|
| Global | `~/.pi/agent/settings.json` | `~/.pi/agent/packages/<name>/` |
| Project | `.pi/settings.json` | `.pi/packages/<name>/` |

Other entries in `settings.json` are preserved across installs and refreshes; vstack only mutates the `packages` array, dedupes the entries it owns, and writes the file back. A legacy absolute-path entry (from earlier vstack versions) is replaced with the canonical relative form on the next `vstack add`/`refresh`.

The `pi-extension-manager` package stores its own disabled lists and extension setting values under `vstack.extensionManager` in Pi settings. That namespace is intentionally separate from Pi's top-level `extensions` resource-path setting.

## License

MIT
