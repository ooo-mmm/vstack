# pi-output-policy

![Output Policy settings panel](https://raw.githubusercontent.com/vanillagreencom/vstack/main/pi-extensions/pi-output-policy/assets/settings-panel.png)

OMP-style large-output policy for Pi tool results.

## Install

Via [npm](https://www.npmjs.com/package/@vanillagreen/pi-output-policy):

```bash
pi install npm:@vanillagreen/pi-output-policy
```

Via [vstack](https://github.com/vanillagreencom/vstack):

```bash
cargo install --git https://github.com/vanillagreencom/vstack.git vstack
vstack add vanillagreencom/vstack --pi-extension pi-output-policy --harness pi -y
```

Restart Pi after installation.

## What it does

- Preserves oversized output under `~/.pi/agent/vstack/sessions/<session-id>/pi-output-policy/artifacts/` when possible; never under the project `.pi/` directory. Legacy `~/.pi/agent/vstack/pi-output-policy/sessions/<session-id>/artifacts/` trees are migrated on first use.
- Uses head truncation for search/listing tools and tail truncation for command/log tools.
- Adds explicit truncation notices with size, line count, direction, and artifact path.
- Leaves file `read` results unmodified by default; enable `truncateReadOutputs` to cap reads.
- Leaves edit/write results and diff details unmodified by default; enable `truncateMutationOutputs` to cap file mutations.
- Leaves details payloads intact by default so extension state, subagent details, and diffs are preserved; enable `sanitizeDetails` for stricter UI safety caps.
- Keeps shell-output minimization off by default; enable `shellMinimizer.enabled` to compress noisy command logs before truncation.

## Limit

Pi's built-in tools may already truncate before `tool_result`. This extension can only preserve the text it receives, so custom tools that return full large text benefit most from spill preservation.

For truncated file reads, continue reading the original source file with `offset`/`limit`. Session `tool-results/*.json` files are wrapper artifacts for the already-returned tool result; they may contain escaped, line-hostile JSON and usually do not recover file content beyond Pi's read limit.
