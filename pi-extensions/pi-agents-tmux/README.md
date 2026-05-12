# pi-agents-tmux

https://github.com/user-attachments/assets/36192e57-a6e4-47f9-b47c-dd26920906ae

Delegate work to specialized agents from a running Pi session. Agents run either as visible persistent tmux panes or as background one-shot sessions.

## Highlights

- `subagent` tool delegates one task, parallel tasks, or sequential chains.
- Agents with `pane: true` open a visible tmux pane that persists across turns. Other agents run in the background.
- `/agents` browser lists project and user agents with search, preview, and one-key launch.
- Dashboard widget shows live state, model, turns, tokens, and cost for every spawned agent.
- Grouped completion notifications batch multiple agents finishing together.
- `taskId` retrieval, mid-run steering, and pane stop without losing memory.
- Stop kills the tmux process but preserves the session — next launch resumes it.

## Install

Via [npm](https://www.npmjs.com/package/@vanillagreen/pi-agents-tmux):

```bash
pi install npm:@vanillagreen/pi-agents-tmux
```

Via [vstack](https://github.com/vanillagreencom/vstack):

```bash
cargo install --git https://github.com/vanillagreencom/vstack.git vstack
vstack add vanillagreencom/vstack --pi-extension pi-agents-tmux --harness pi -y
```

Restart Pi after installation.

Persistent panes require running Pi inside tmux.

## Tool

Single task:

```json
{ "agent": "rust", "task": "Inspect error handling and summarize findings." }
```

Parallel:

```json
{ "tasks": [
  { "agent": "iced", "task": "Review the widget layout." },
  { "agent": "reviewer-test", "task": "Check test coverage gaps." }
] }
```

Chain (with `{previous}` placeholder):

```json
{ "chain": [
  { "agent": "scout", "task": "Map the relevant files." },
  { "agent": "planner", "task": "Turn this into a plan: {previous}" }
] }
```

Useful options: `agentScope` (`project` default, `user`, `both`), `cwd` per task, `confirmProjectAgents` to prompt before running project agents.

Persistent panes return a `taskId`. Keep it to retrieve or steer the task later.

Bg agents resume per parent session by default. Pass `sessionKey: "<stable-id>"` for a separate named memory lane. Pane agents persist via their own session file and ignore `sessionKey`.

## Commands

| Command | Action |
| --- | --- |
| `/agents` | Open the agent browser. |
| `/agents project\|user\|both` | Open the browser with an explicit scope. |
| `/agents show <name> [scope]` | Inspect an agent. |
| `/agents:start <name>` | Start or resume a pane. |
| `/agents:new <name>` | Archive the saved session and start fresh. |
| `/agents:resume <name> [latest\|archive-file]` | Restore an archived pane session. |
| `/agents:send <name> <task>` | Queue a task for a persistent pane. |
| `/agents:attach <name>` | Focus an existing pane. |
| `/agents:stop <name>` | Stop a persistent pane. |
| `/agents status` | Show pane status. |
| `/agents collect` | Collect completed pane results. |
| `/agents:trace <ref>` | Open or show one trace by task id or short id. |
| `/agents:toggle` | Toggle the persistent dashboard. |

Arguments support autocomplete, including known agent names.

## Browser keys

- Type to search by name, description, source, path, model, denied tools, or pane status.
- `Tab` / `Shift+Tab` switches scope tabs.
- `↑/↓`, `-/=`, `Home/End` navigate. `←/→` switches list/inspector focus.
- `Enter` inserts `Use agent <name> to: ` into the editor.
- `Alt+M` edits the selected agent's frontmatter.
- For pane agents: `Ctrl+P` starts/reuses, `Ctrl+O` attaches, `Ctrl+X` stops.
- `Esc` clears search or closes.

Status legend: ` ` live pane, ` ` startable, ` ` stale, `·` background. Dashboard rows: ` ` queued, ` ` working, ` ` completed, ` ` needs completion, ` ` failed/blocked.

## Dashboard widget

Alt+A cycles the widget hidden → compact → expanded. Alt+Shift+A or F3 opens the full `/agents` popup.

Each row shows agent name, kind (`pane` or `bg`), turn count, input/output tokens, and cost. Compact mode aggregates totals on a single line; expanded adds a `Total` row at the bottom.

When the dashboard is on, inline tool output stays quiet — pane calls render as launch breadcrumbs, bg/one-shot calls show a result preview.

## Persistent pane agents

Agents with `pane: true` use a visible tmux pane:

```yaml
---
name: iced
description: Iced UI specialist
deny-tools: bash
model: openai-codex/gpt-5.5:xhigh
color: cyan
pane: true
---
```

Frontmatter fields:

| Field | Required | Values |
| --- | --- | --- |
| `name` | yes | Unique agent name. |
| `description` | yes | Short description shown in `/agents` and completions. |
| `deny-tools` | no | Comma-separated Pi tools to deny. Future parent tools are inherited unless explicitly denied. |
| `model` | no | Pi model id; shorthands: `sonnet`, `opus*`, `haiku`. Other ids pass through. |
| `pane` | no | `true` for a visible persistent pane; omit for bg one-shot. |
| `color` | no | Pane badge color: `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`. Aliases: `orange`, `purple`/`violet`, `teal`. |

Everything after the frontmatter is the agent's system prompt.

Pane tasks move through `queued → running → completed | blocked | failed`. If a child ends a turn without a valid completion record, the task is marked `needs_completion` and the child shows a warning.

## Result retrieval and steering

Dispatch and end your turn — the extension wakes the parent on completion. Use `get_subagent_result` only as a fallback if you suspect a missed wake event. Pass `wait: true` to block the current turn (use sparingly).

```json
{ "taskId": "iced-..." }
```

Use `steer_subagent` for mid-run correction. It targets `pi-session-bridge` when available; otherwise it queues a steering note for the pane to read when idle.

```json
{ "taskId": "iced-...", "message": "Prioritize the failing layout test.", "deliverAs": "steer" }
```

Use `stop_subagent` to kill a persistent pane. The session file is preserved; the next launch resumes memory.

## Settings

All settings live in the extension manager under **Agents (tmux)**.

### Execution

| Setting | What it does |
| --- | --- |
| Enable agents | Master toggle for the subagent tools, dashboard, and pane helpers. |
| Max parallel tasks | Cap on tasks in one parallel agent call. |
| Max concurrency | Cap on one-shot processes running simultaneously. |
| Subagent model source | Use the agent's `model:` or inherit the parent session model. |
| Subagent thinking source | Use the model `:effort` suffix or inherit the parent thinking level. |

### Rendering

| Setting | What it does |
| --- | --- |
| Show agent dashboard | Render the activity card above the editor. |
| Quiet inline output with dashboard | Keep inline tool output to short crumbs. |
| Dashboard max items | Maximum agent rows shown. |
| Dashboard collapsed by default | Start collapsed. |
| Tree connector style | `unicode` or `ascii`. |
| Collapsed item count | Items shown in collapsed agent results. |

### Output

| Setting | What it does |
| --- | --- |
| Truncate agent results | Apply Pi-sized inline caps to tool output. |
| Result max bytes | Inline byte cap per agent result. |
| Result max lines | Inline line cap per agent result. |
| Preserve full agent output | Save oversized output to the session runtime and include the artifact path. |

### Persistent panes

| Setting | What it does |
| --- | --- |
| Completion poll interval | Parent poll rate for pane completion files. |
| Child inbox poll interval | Child pane poll rate for incoming tasks. |
| Force session bridge for panes | Load `pi-session-bridge` in pane launchers so steering keeps working. |

### Keyboard

| Setting | What it does |
| --- | --- |
| Dashboard display shortcut | Cycles widget visibility. Default `alt+a`. |
| Agents popup shortcut | Opens the full `/agents` browser. Default `alt+shift+a` (F3 also works). |
