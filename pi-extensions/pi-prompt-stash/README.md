# pi-prompt-stash

![Prompt Stash popup](https://raw.githubusercontent.com/vanillagreencom/vstack/main/pi-extensions/pi-prompt-stash/assets/stash-popup.png)

Per-session prompt stash. Save a draft, write something else, restore later.

## Highlights

- `Alt+S` with editor text stashes the prompt and clears the editor.
- `Alt+S` with empty editor opens the stash popup.
- Searchable popup with restore, delete, and clear-all.
- Stashes are per-session and survive Pi restarts within the session.
- Optional deduplication discards older entries with identical text.

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

| Key | Action |
| --- | --- |
| `Alt+S` (editor has text) | Stash the current prompt and clear the editor. |
| `Alt+S` (editor empty) | Open the stash popup. |
| Type | Search stashed prompts. |
| `↑` / `↓` | Move selection. |
| `Enter` | Restore the selected prompt. Stash unchanged. |
| `Ctrl+D` or `Delete` | Delete the selected prompt. |
| `Ctrl+X`, then `Enter` | Delete all stashed prompts. |
| `Esc` | Close. |

## Settings

Open `/extensions:settings`; settings appear under the **Prompt Stash** tab.

| Setting | What it does |
| --- | --- |
| Stash shortcut | Default `alt+s`. |
| Store file | File name inside the per-session stash directory. |
| Deduplicate prompts | Remove older entries with identical text when stashing. |
| Popup width | Preferred popup width. |
| Popup max height | Maximum overlay height. |
| Visible stash rows | Rows shown before scrolling. |
