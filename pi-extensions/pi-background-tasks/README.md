# pi-background-tasks

Pi package for explicit, non-blocking background shell tasks.

## What it provides

- `bg_task` tool: spawn, list, tail logs, stop, and clear tracked tasks.
- `bg_status` compatibility tool: list/log/stop by PID.
- `/bg` command: manual task dashboard and task controls.
- `Ctrl+Shift+B`: opens a padded, bordered background task dashboard in interactive Pi.
- Persistent log files under `${PI_BG_TASK_DIR:-$TMPDIR/vstack-pi-bg}`.
- Completion wakeups: spawned tasks can notify the agent when they exit, and optionally when matching output arrives.

## Examples

```text
/bg run cargo test
/bg list
/bg log bg-1
/bg stop bg-1
/bg clear
```

Agent tool example:

```json
{"action":"spawn","command":"sleep 20; echo done","notifyOnExit":true}
```

Useful spawn options:

- `notifyOnExit` defaults to `true`.
- `notifyOnOutput` defaults to `false`; set `notifyPattern` to a substring or `/regex/flags` to gate output wakeups.
- `timeoutSeconds` defaults to `600`; set `0` to disable expiry.

## Notes

Tasks are scoped to the current Pi runtime and are stopped on session shutdown. Shells are started in their own process group on Unix so `/bg stop` and shutdown terminate child processes as well as the shell.

## Attribution

This package is locally owned by vstack and is based on ideas and portions of the MIT-licensed `@ifi/pi-background-tasks` package from `ifiokjr/oh-pi`. See `THIRD_PARTY_NOTICES.md`.
