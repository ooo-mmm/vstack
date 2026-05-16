# Flightdeck

Flightdeck supervises AI harness sessions in tmux windows. In core session mode it launches or attaches panes, tracks stable ids, routes prompts, and summarizes completion. Issue orchestration is a built-in domain mode layered on top: GitHub/Linear/worktree decisions, merge planning, and next-cycle recommendations.

> Agents reading this: you want `SKILL.md` instead. Hacking on flightdeck itself: see [`DEVELOPMENT.md`](./DEVELOPMENT.md).

## The problem

Running one agent at a time is fine. Running five at once is chaos — each one keeps stopping to ask questions, background tasks finish at odd times, and issue-mode merge order can turn into a guessing game. Flightdeck handles the supervisory layer so you can track generic sessions or spawn a whole issue cycle and walk away.

Activates only inside tmux and only when you ask for it (`flightdeck session start|attach` for core sessions, `flightdeck start` for issue workflows). Outside tmux it's a no-op.

## How it works

Flightdeck launches generic sessions with `flightdeck session start` (or `attach`) or issue agents with `flightdeck start`, always into their own tmux windows, then watches them in parallel. Each agent talks to flightdeck through its native channel (Claude Code MCP, OpenCode HTTP, Pi bridge, Codex app-server) and falls back to tmux when a channel isn't available.

A background daemon detects when an agent has a question, the master agent classifies the prompt, auto-answers when there's a learned default, and pauses for the human when there isn't.

There are two modes per tracked entry:

- **Generic session mode** — structured questions, bash permission prompts, safe bounded choices, Pi background-task exits.
- **Issue mode** — adds GitHub/Linear/worktree decisions: cleanup, rebase, force-push, bot-review/CI recovery, merge planning, scope creep.

When all tracked entries are terminal, flightdeck writes a summary and hands control back.

## Activation and termination

- **Activates** on `flightdeck session start|attach` for generic tracked sessions, or `flightdeck start` for issue workflows, from inside tmux.
- **Pauses** for you on: scope creep that wants reverting, force-merging against a real content conflict, an issue abort, a `main` mutation that needs human OK, domain mismatch, or a novel prompt shape no rule covers. Sets `paused_for_user` in state and stops polling. Resume by running `session watch` or issue `watch` again.
- **Terminates** automatically when every tracked entry is terminal for the relevant mode. Generic-only sessions write a session summary with no GitHub/Linear/worktree calls. Issue sessions write the issue summary, archive the state file, and hand control back.

## Ad-hoc sessions

Ask the agent to track an ad-hoc tmux window (a scratch Pi pane, a log tail, an extra worker) and it will call `flightdeck session start` or `flightdeck session attach` for you. Useful when you want supervision and a dashboard row but no issue/worktree wiring. See [`DEVELOPMENT.md`](./DEVELOPMENT.md) for the script flag reference.

## Issue workflows

Issue orchestration remains first-class when the session is tied to a Linear/GitHub/worktree domain. Ask the agent to start an issue, check a parallel group for safety, launch the group, watch the session, recompute merge order, or close out the session — it routes to the right flightdeck command for you.

## Install

```bash
cd /path/to/your/project
vstack add vanillagreencom/vstack --skill flightdeck -y
```

Core mode requires tmux only at the workflow/skill-dependency layer, plus the harness adapter you choose for a tracked pane (`pi-bridge`, OpenCode HTTP, Claude Channels, Codex app-server, or tmux fallback). It does not require GitHub, Linear credentials, project-management, or worktree setup.

Issue mode adds the optional `github`, `linear`, `worktree`, and `project-management` skills on demand for `flightdeck start <ISSUE>`, `start new`, `parallel-check`, `merge-plan`, `close-issue`, and issue termination/recommendation workflows.

Runtime requirements for the shipped core scripts remain `bash` 4+, `tmux` 3.x, `jq`, `flock`, and `bun` (https://bun.sh). Issue mode additionally needs the GitHub/Linear CLIs or auth wrappers used by those skills, plus normal git worktree support. Mac users: install GNU coreutils for `sha256sum` and GNU date.

## Rust dashboard

The Rust dashboard binary lives at `skills/flightdeck/lib/flightdeck-dashboard/`, with the user-facing trampoline at `skills/flightdeck/scripts/flightdeck-dashboard`. It is a ratatui view of the master state file: it renders tracked sessions, owner/observer status, pause/stale/archive/pre-purge banners, cross-harness cost/token totals, the Activity tab (formerly Live feed), conversations, decisions, merges, and daemon health. Live mode file-watches the state/archive/activity paths with debounced reloads; the optional Rust daemon adds a UDS JSON-RPC snapshot stream and Pi-only wake subscriber absorption. Mouse support covers tabs, rows, pause/banner chips, the daemon/theme/cost chips, footer hints, popup controls, and panel scrolling. The only write actions are confirmation-gated shells to canonical helpers: prune stale registry entries through `pane-registry remove` and focus a session through `tmux select-window`.

`flightdeck-dashboard launch` is the best-effort startup hook used by Flightdeck. It opens one tracked tmux window through `flightdeck-session start --kind workflow --harness shell`, registers `.entries.flightdeck-dashboard`, and skips cleanly outside tmux, when disabled, or when tmux idempotency probes fail. Use `launch --theme moon|dawn|pantera|system` to forward a theme to the child TUI. It honors:

| Variable | Purpose |
| --- | --- |
| `FLIGHTDECK_DASHBOARD=0` | Exit `0` silently without launching the dashboard. |
| `FLIGHTDECK_DASHBOARD_WINDOW` | Tmux window name, default `flightdeck`. |
| `FLIGHTDECK_DASHBOARD_MOTION` | Motion level: `full`, `reduced`, or `off`; `NO_MOTION` / `NO_COLOR` force `off`. |
| `FLIGHTDECK_DASHBOARD_THEME` | Theme: `moon` (default Rose Pine Moon), `dawn`, `pantera` (Crush-inspired neon), or `system`; CLI `--theme` overrides it. |
| `FLIGHTDECK_DAEMON_RUST=1` | Opt into the Rust daemon wake side; default off keeps the canonical TypeScript daemon in charge of wake delivery. |
| `FLIGHTDECK_DASHBOARD_BELL=0` | Suppress the pause-edge terminal bell. |
| `FLIGHTDECK_DASHBOARD_COST_POLL_SECS` | Cost-source poll interval, default `5`. |
| `FLIGHTDECK_DASHBOARD_PRICING_FILE` | Override the bundled per-million-token pricing TOML; malformed files warn and fall back to bundled rates. |
| `FLIGHTDECK_DASHBOARD_QUICK_FOCUS=1` | Skip the focus confirmation popup for power users. Prune always requires confirmation. |
| `TMUX_PROBE_TTL` | Cached `tmux list-panes` stale-row probe TTL, default `5` seconds. |
| `FLIGHTDECK_DASHBOARD_STALE_WARN_SECS` / `FLIGHTDECK_DASHBOARD_STALE_DEAD_SECS` | Tune stale-chip thresholds. |

`flightdeck-dashboard tui --demo[=NAME]` runs compiled demo fixtures (`empty`, `one-adhoc`, `one-issue`, `mixed`, `terminated`, `paused`, `observer`, `conversations`, `no-issue`, `decisions`). `tui --state-file <path>` reads a concrete master-state JSON file, and `tui --session <name>` resolves `<project-root>/<FLIGHTDECK_STATE_DIR>/flightdeck-state-<name>.json` (default state dir `tmp/`) with terminated-archive fallback. With neither flag inside tmux, the dashboard uses the current tmux session. Use `--theme moon|dawn|pantera|system` to select Rose Pine Moon, Rose Pine Dawn, Pantera neon, or terminal-system colors. `?` opens Help with the legend, `T` opens the theme picker, `/` opens the filter popup, `Enter` opens the selected session/decision/event detail popup, `g` confirms focus for the selected pane, and `D` confirms prune for stale rows.

The legacy in-Pi dashboard extension remains documented in [`pi-extensions/pi-flightdeck/README.md`](../../pi-extensions/pi-flightdeck/README.md), but it is deprecated for new sessions. Prefer the Rust dashboard for new Flightdeck runs.

After `vstack add`, build the release binary with:

```bash
cd skills/flightdeck/lib/flightdeck-dashboard
cargo build --release
```

The script prefers `lib/flightdeck-dashboard/target/release/flightdeck-dashboard` and falls back to `cargo run --release` when the binary is absent.

## Pi dashboard (optional)

New sessions should prefer the Rust dashboard above. If your master agent runs in Pi and you still want in-editor mission control, the deprecated [`pi-flightdeck`](../../pi-extensions/pi-flightdeck/README.md) extension remains available as a read-only overlay — pause banner, persistent dashboard above the editor, `/flightdeck` popup with six tabs. The skill works identically with or without it.

```bash
vstack add vanillagreencom/vstack --pi-extension pi-flightdeck --harness pi -y
```

## Settings worth knowing

Most users never touch these. The ones that occasionally matter:

| Variable | What it does |
| --- | --- |
| `FLIGHTDECK_AUTO_MERGE` | Set to `0` to require a human OK on every merge instead of auto-handling the obvious case. Useful for compliance-sensitive repos or big-blast-radius PRs. |
| `FLIGHTDECK_FORCE_MERGE_AFTER_SECS` | How long flightdeck waits before force-merging a PR that's approved + green but stuck in GitHub's `UNKNOWN` merge state (default 4 minutes). |
| `FLIGHTDECK_LAUNCH_MODEL` / `FLIGHTDECK_LAUNCH_EFFORT` | Default model + thinking level for spawned agents when the user doesn't pass them explicitly. |
| `FLIGHTDECK_STATE_DIR` | Where flightdeck writes its session state file inside the project. Defaults to `tmp/`. |
| `FLIGHTDECK_ACTIVITY_FILE` | Override the activity JSONL sidecar path for wrapper/workflow emitters and `flightdeck-state activity append`. |
| `FLIGHTDECK_DASHBOARD` | Set to `0` to disable the Rust dashboard launch hook silently. |
| `FLIGHTDECK_DASHBOARD_WINDOW` | Tmux window name for the Rust dashboard launch hook. Defaults to `flightdeck`. |
| `FLIGHTDECK_DASHBOARD_MOTION` | Rust dashboard motion level: `full`, `reduced`, or `off`. `NO_MOTION` and `NO_COLOR` also disable motion. |
| `FLIGHTDECK_DASHBOARD_THEME` | Rust dashboard theme: `moon` (default), `dawn`, `pantera`, or `system`. CLI `--theme` wins over the env var. |
| `FLIGHTDECK_DAEMON_RUST` | Set to `1` to let `flightdeck-dashboard launch` start the Rust daemon; unset/`0` defers daemon ownership to the canonical TypeScript path. |
| `FLIGHTDECK_DASHBOARD_BELL` | Set to `0` to suppress the terminal bell on a new pause-for-user edge. The dashboard never auto-focuses tmux windows. |
| `FLIGHTDECK_DASHBOARD_COST_POLL_SECS` | Rust dashboard cost-source poll interval (default `5`). |
| `FLIGHTDECK_DASHBOARD_PRICING_FILE` | Path to a pricing TOML override for dashboard cost calculations. |
| `FLIGHTDECK_DASHBOARD_QUICK_FOCUS` | Set to `1` to make `g` focus without confirmation. |
| `TMUX_PROBE_TTL` | Stale-pane probe cache TTL in seconds (default `5`). |
| `FLIGHTDECK_DASHBOARD_STALE_WARN_SECS` | Rust dashboard stale-warning threshold in seconds (default `30`). |
| `FLIGHTDECK_DASHBOARD_STALE_DEAD_SECS` | Rust dashboard stale/dead threshold in seconds (default `300`). |
| `FLIGHTDECK_PI_ACTIVITY_BROKER` | Set to `0` to disable `pi-session-bridge` `vstack_activity` broker consumption and rely on legacy Pi wake messages only. Default `1`. |

Activity history lives beside the master state as `<FLIGHTDECK_STATE_DIR>/flightdeck-activity-<session>.jsonl`. `flightdeck-state activity path|append|tail|export` exposes the path, writes normalized activity rows, tails recent rows, or exports JSONL/Markdown. Event families include tracked entries (`entry.*`), agents (`agent.*`), background tasks (`bg_task.*`), PRs (`pr.*`), Linear writes (`linear.*`), questions, and daemon/subscriber lifecycle rows. Pi sessions also append activity-only rows from the `pi-session-bridge` activity broker (`vstack_activity`) when enabled. `flightdeck-state archive` archives the activity JSONL next to the master-state archive.

Daemon-private files live outside your project under `$XDG_RUNTIME_DIR/flightdeck` (fallback `/tmp/flightdeck-$UID`) so they don't show up in commits.

Daemon tuning (`FD_*` env vars) is documented in [`DEVELOPMENT.md`](./DEVELOPMENT.md). Defaults work for normal use.

## Out of scope

- Flightdeck does not abort issues for you — only you can.
- Flightdeck does not respawn dead panes.
- Flightdeck operates within one tmux session at a time. Multiple sessions are independent.
- Flightdeck does not bypass the parallel-safety check that orchestration runs before spawn. If that check says no, flightdeck doesn't override.
