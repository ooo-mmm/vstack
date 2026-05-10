# pi-session-manager

![Session Manager overlay and model-change confirmation](https://raw.githubusercontent.com/vanillagreencom/vstack/main/pi-extensions/pi-session-manager/assets/session-manager.gif)

Polished session manager overlay for Pi. It complements Pi's built-in `/resume` picker with vstack settings, inline management actions, and guarded rendering for long or control-character-heavy session text.

## Install

Via [npm](https://www.npmjs.com/package/@vanillagreen/pi-session-manager):

```bash
pi install npm:@vanillagreen/pi-session-manager
```

Via [vstack](https://github.com/vanillagreencom/vstack):

```bash
cargo install --git https://github.com/vanillagreencom/vstack.git vstack
vstack add vanillagreencom/vstack --pi-extension pi-session-manager --harness pi -y
```

Restart Pi after installation.

## What it provides

- Browse current-project sessions or all sessions.
- Search by tokens, quoted phrases, or `re:<regex>` using the same prompt-first matching logic as the session search popup: user prompts are matched first, with session title/name fallback.
- Threaded lineage view using Pi `parentSession` relationships when there is no active search.
- Resume through `ctx.switchSession()`, preserving the session's saved model by default. If the current active model differs, a confirmation popup explains the models and lets you continue with either one.
- Rename sessions using Pi session-info entries; current-session renames go through `pi.setSessionName()`.
- Delete one session or all shown deletable sessions with confirmation, current-session protection, visible delete counts, and optional `trash` CLI fallback. Deletes also remove that session's per-extension data under `~/.pi/agent/vstack/sessions/<session-id>/` (and the legacy `~/.pi/agent/vstack/<package>/sessions/<session-id>/` trees) so dropped sessions don't leave orphaned data behind.
- Clean one-line rendering for names, prompts, and paths.

No SQLite, FTS, or native runtime dependencies are used; Pi's `SessionManager.list()` / `listAll()` APIs provide the index data.

## Commands

| Command | Action |
| --- | --- |
| `/sessions` | Open the manager using the configured default scope; switch Current/All with the tabs. |
| `/sessions:resume-pending <id>` | Internal recovery command inserted into the editor when a resume action must be confirmed by pressing Enter. |

## Keys

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move selection. |
| `-` / `=` | Page the list. |
| `Home` / `End` | Jump to first/last result. |
| `Enter` | Resume selected session. If the session model differs from the current active model, choose which model to continue with. |
| `Alt+R` | Rename selected session inline. |
| `Delete` | Delete selected session after confirmation. |
| `Alt+D` | Delete all shown deletable sessions after confirmation. |
| `Tab` | Toggle current/all scope. |
| `Alt+S` | Cycle threaded/recent/relevance sort. |
| `Alt+N` | Toggle named-only filter. |
| `Esc` / `Ctrl+C` | Clear search, cancel rename/delete/model selection, or close. |

The global shortcut defaults to `F1` and opens the manager popup directly. Set `shortcutKey` to `none` to disable it.

## Settings

Settings are exposed through `pi-extension-manager` under `vstack.extensionManager.config.@vanillagreen/pi-session-manager`.

| Key | Default | Notes |
| --- | --- | --- |
| `enabled` | `true` | Registers commands and shortcut after reload. |
| `shortcutKey` | `f1` | Opens the manager popup directly. Set to `none` to disable. |
| `defaultScope` | `current` | Initial Current/All tab when opening `/sessions`. |
| `defaultSort` | `threaded` | `threaded`, `recent`, or `relevance`. |
| `visibleRows` | `12` | List rows before scrolling. |
| `overlayWidth` | `112` | Preferred overlay width in terminal columns. |
| `deleteUsesTrash` | `true` | Try `trash` before `unlink` when deleting. |

## Notes

- Session titles mirror Pi `/resume`: explicit session name, first user message, then filename.
- Search filters the shown list. Delete-all acts only on the currently shown, deletable sessions.
- If `sessionDir` or `PI_CODING_AGENT_SESSION_DIR` is configured, current scope filters by session `cwd`; all scope shows every session in that directory.
- Pi's built-in `/resume`, `/tree`, `/fork`, `/clone`, and `/name` remain available.
