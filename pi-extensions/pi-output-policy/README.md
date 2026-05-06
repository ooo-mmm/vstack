# pi-output-policy

![Output Policy settings panel](https://raw.githubusercontent.com/vanillagreencom/vstack/main/pi-extensions/pi-output-policy/assets/settings-panel.png)

OMP-style large-output policy for Pi tool results.

## What it does

- Preserves oversized output under `~/.pi/agent/vstack/pi-output-policy/sessions/<session-id>/artifacts/` when possible; never under the project `.pi/` directory.
- Uses head truncation for search/listing tools and tail truncation for command/log tools.
- Adds explicit truncation notices with size, line count, direction, and artifact path.
- Leaves file `read` results unmodified by default; enable `truncateReadOutputs` to cap reads.
- Leaves edit/write results and diff details unmodified by default; enable `truncateMutationOutputs` to cap file mutations.
- Leaves details payloads intact by default so extension state, subagent details, and diffs are preserved; enable `sanitizeDetails` for stricter UI safety caps.
- Keeps shell-output minimization off by default; enable `shellMinimizer.enabled` to compress noisy command logs before truncation.

## Limit

Pi's built-in tools may already truncate before `tool_result`. This extension can only preserve the text it receives, so custom tools that return full large text benefit most from spill preservation.
