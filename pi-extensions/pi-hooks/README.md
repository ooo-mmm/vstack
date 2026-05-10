# @vanillagreen/pi-hooks

First-class Pi port of the vstack safety hooks. Same behaviors as the shell scripts in `vstack/hooks/`, implemented natively against Pi's `tool_call` / `tool_result` / `turn_end` event API so they participate in Pi's tool lifecycle without spawning a shell.

Each hook is independently toggleable from the pi-extension-manager UI.

## Hooks

| Hook | Pi event | Behavior |
|---|---|---|
| `blockBareCd` | `tool_call` (bash) | Returns `{block: true, reason}` when the command is a bare `cd /path` with no subshell or chaining. Pi short-circuits the tool call. |
| `preCommitCheck` | `tool_call` (bash) | Detects `git commit`. Runs `cargo fmt --check` then `cargo clippy --workspace --all-targets -- -D warnings`. Blocks the commit on failure. Only fires when staged files include `.rs`. |
| `postEditLint` | `tool_result` (edit/write of `.rs`) | Runs workspace clippy, filters lines mentioning the edited file, and appends them as an extra text content part on the tool result. Advisory only — the edit is not reverted. |
| `taskCompletedCheck` | `turn_end` | If any `.rs` file was touched during the turn, runs workspace clippy and surfaces errors via `ctx.ui.notify`. Pi has no native equivalent of Claude Code's `TaskCompleted` block-the-done-state semantics, so this is advisory. |

## Parity rule

These hooks must stay behaviorally in sync with `hooks/*.sh` in this repo. The vstack rule: **any change to a hook script must land alongside the matching change in `pi-hooks`.** See [AGENTS.md](../../AGENTS.md) for the canonical rule.

## Configuration

Settings live in `<scope>/.pi/settings.json` under `vstack.extensionManager.config["@vanillagreen/pi-hooks"]`. The schema is declared in `package.json` and rendered by pi-extension-manager. Defaults are conservative: all four hooks are enabled.

```json
{
  "vstack": {
    "extensionManager": {
      "config": {
        "@vanillagreen/pi-hooks": {
          "enabled": true,
          "blockBareCd": true,
          "preCommitCheck": true,
          "postEditLint": true,
          "taskCompletedCheck": true,
          "clippyTimeoutMs": 120000
        }
      }
    }
  }
}
```

## Install

```bash
vstack add --pi-extension pi-hooks
```

Or as part of `vstack add --all`. Refresh with `vstack refresh`.
