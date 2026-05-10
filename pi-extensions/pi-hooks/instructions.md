## pi-hooks — safety hooks for bash, edit, write, turn-end

Active hooks (each independently toggleable in pi-extension-manager settings):

- **Bare `cd`** is blocked. A bash command of the form `cd /path` (no `&&`, no `|`, no `;`, not in a subshell) will fail with a hook block. Use `(cd /path && command)` instead — that scopes the directory change to the subshell and does not leak into later tool calls.
- **`git commit` is gated.** Before the commit runs, the extension runs `cargo fmt --check` and `cargo clippy --workspace --all-targets -- -D warnings`. Either failure blocks the commit. Fix formatting (`cargo fmt`) or lint warnings before retrying.
- **Edits to `.rs` files are linted.** After every `edit`/`write` tool result on a `.rs` file, clippy runs and any output lines mentioning that file are appended to the tool result. Read them and decide whether to fix immediately or note for later.
- **End-of-turn lint summary.** If the turn touched any `.rs` files, a final workspace clippy runs at `turn_end`. Workspace-level errors surface as a UI notification. This is advisory — Pi has no event that can block the done state.

If a hook fires unexpectedly, check the pi-extension-manager Hooks panel: each can be toggled off live without restarting Pi.
