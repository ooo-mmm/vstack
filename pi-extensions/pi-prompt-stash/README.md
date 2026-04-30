# pi-prompt-stash

A polished Pi package for per-session prompt stash history.

## Usage

- `Alt+S` with editor text: stash the current prompt and clear the editor.
- `Alt+S` with an empty editor: open the stash popup.
- `/prompt-stash`: open the stash popup.

Popup controls:

- Type to search.
- `↑/↓` or `j/k` to select.
- `Enter` to pop the selected prompt into the editor and remove it from the stash.
- `Ctrl+D` or `Delete` to delete the selected prompt.
- `Ctrl+X` to delete all stashed prompts, then `y` to confirm.
- `Esc` to close.

Stashes are stored per Pi session under `~/.pi/agent/vstack/prompt-stash/sessions/<session-id>/prompt-stash.json`, even when the package is enabled by project settings. The extension still reads legacy manager config under `prompt-stash`, and legacy `.pi/prompt-stash.json` files are imported into the current session and removed on load/use.
