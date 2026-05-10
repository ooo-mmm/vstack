# pi-prompt-stash

![Prompt Stash popup](https://raw.githubusercontent.com/vanillagreencom/vstack/main/pi-extensions/pi-prompt-stash/assets/stash-popup.png)

Per-session prompt stash history for Pi.

## Install

Via [npm](https://www.npmjs.com/package/@vanillagreen/pi-prompt-stash):

```bash
pi install npm:@vanillagreen/pi-prompt-stash
```

Via [vstack](https://github.com/vanillagreencom/vstack):

```bash
cargo install --git https://github.com/vanillagreencom/vstack.git vstack
vstack add vanillagreencom/vstack --pi-extension pi-prompt-stash --harness pi -y
```

Restart Pi after installation.

## Commands

| Command | Action |
| --- | --- |
| `/prompt-stash` | Open the stash popup. |

## Keys

- `Alt+S` with editor text: stash the current prompt and clear the editor.
- `Alt+S` with an empty editor: open the stash popup.

Popup controls:

| Key | Action |
| --- | --- |
| Type | Search stashed prompts. |
| `↑` / `↓` | Move selection. |
| `Enter` | Restore the selected prompt into the editor. The stash is unchanged. |
| `Ctrl+D` or `Delete` | Delete the selected prompt. |
| `Ctrl+X`, then `Enter` | Delete all stashed prompts. |
| `Esc` | Close. |

## Storage

Stashes are stored per Pi session under `~/.pi/agent/vstack/sessions/<session-id>/prompt-stash/prompt-stash.json`, even when the package is enabled by project settings. Legacy `~/.pi/agent/vstack/prompt-stash/sessions/<session-id>/` trees are migrated on first stash. Legacy manager config under `prompt-stash` is still read, and legacy `.pi/prompt-stash.json` files are imported into the current session and removed on load/use.
