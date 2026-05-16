# pi-agents-tmux agent notes

- Activity broker publication lives in `extensions/subagent/activity.ts` and uses `globalThis[Symbol.for("vstack.pi.activity")]` when `pi-session-bridge` is loaded.
- Keep broker emission fail-open: subagent dispatch, steering, completion, and result retrieval must not depend on activity publish success.
- Lifecycle mapping is `subagents:*` → `agent.*`; update README and DEVELOPMENT.md when adding or renaming activity event types.
