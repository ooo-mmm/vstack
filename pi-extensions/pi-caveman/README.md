# pi-caveman

Native Pi caveman communication mode.

Commands:

- `/caveman` — enable the configured default mode if off, otherwise show status.
- `/caveman lite|full|ultra|wenyan-lite|wenyan|wenyan-full|wenyan-ultra`
- `/caveman off`
- `/caveman status`

The extension injects instructions in `before_agent_start`; it does not post-process model output. Mode persists in the Pi session via custom session entries.

Clarity/safety escape is implemented as prompt policy: destructive/security/clarification turns get explicit normal-clarity guidance while mode remains active for later turns when `resumeAfterClarityEscape` is enabled.

Deferred: `caveman-commit` and `caveman-review` helper commands.
