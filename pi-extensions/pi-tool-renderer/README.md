# pi-tool-renderer

Compact renderers for built-in Pi tools.

By default this package renders individual non-mutating tool calls (`read`, `bash`, and, when available, `grep`/`find`/`ls`) as compact self-rendered bullet rows and registers `tool_batch` for clean combined output. It re-registers built-in tools with the same names and delegates execution to the original Pi implementations. Legacy stacking for separate native tool calls is available with `stackToolCalls=true`, but it is disabled by default because Pi still reserves layout space for hidden sibling tool entries. Stack rows are width-truncated instead of wrapped to keep ASCII trees compact. It changes only `renderCall`/`renderResult` so `Ctrl+O` remains Pi's expand/collapse mechanism.

It does **not** override Pi's built-in `edit`/`write` renderers by default, so standard diff/edit rendering is preserved. Disable `stackToolCalls` to keep the compact renderers inside Pi's normal tool boxes, or disable `enabled` to return fully to Pi defaults.

It also patches Pi's user-message cards when `compactUserMessages=true` (default): top/bottom padding is removed and the background uses `userMessageBackground` (default `customMessageBg`). Set `compactUserMessages=false` to restore Pi's default padded user cards.

When `stackToolCalls=true`, current Pi still reserves vertical space for each native tool entry even when a renderer returns zero lines. `stackChildDisplay` controls the tradeoff:

- `rows`: child tools render as separate compact `├`/`└` rows.
- `headline`: child rows are hidden and the anchor headline shows the list only when expanded.
- `anchor-list`: child rows are hidden and the anchor headline shows the compact `├`/`└` list by default.

`hideStackChildRows=true` is kept as a legacy alias for `stackChildDisplay="headline"` when `stackChildDisplay` is unset.

Known limitation: Pi currently reserves spacer rows for hidden tool entries, and hidden `Thinking...` labels cannot be fully removed from an extension; fixing those requires Pi core renderer changes.

`tool_batch` is an optional composite tool registered by this package and preferred for multiple independent read/search/list/diagnostic bash operations. It runs `read`/`grep`/`find`/`ls`/diagnostic `bash` calls through Pi's original built-ins but returns one renderable tool result, avoiding the hidden-sibling spacer problem for calls the model chooses to batch. Per-call arguments prefer `{ tool, args }`, but flat calls such as `{ tool: "read", path: "README.md" }` are accepted and normalized. Avoid mutating or order-dependent bash commands in `tool_batch`; keep those as separate `bash` calls.

Set `renderMutationTools=true` to opt into compact `edit`/`write` renderers. When enabled, expanded edit diffs are rendered in full and are not line-truncated by this extension.
