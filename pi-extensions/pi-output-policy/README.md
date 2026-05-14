# pi-output-policy

![Output Policy settings panel](https://raw.githubusercontent.com/vanillagreencom/vstack/main/pi-extensions/pi-output-policy/assets/settings-panel.png)

Large-output policy for Pi tool results: minimization, bounded truncation, and full-output preservation.

## Highlights

- Preserves oversized tool output to disk and includes the artifact path in results.
- Head truncation for search/listing tools; tail truncation for command/log tools.
- Explicit truncation notices show size, line count, direction, and artifact path.
- File reads, edit/write results, and detail payloads pass through unmodified by default — opt in per category.
- Shell output minimizer compresses noisy git/npm/cargo/test output before truncation (off by default).

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

## Settings

Open `/extensions:settings`; settings appear under the **Output Policy** tab.

### Truncation

| Setting | What it does |
| --- | --- |
| Truncate file reads | Apply spill/truncation to `read` results. |
| Truncate edits/writes | Apply spill/truncation to `edit`/`write` results. |
| Output spill threshold (KB) | Preserve full output externally above this size. |
| Inline tail size (KB) | Bytes kept inline for tail-truncated command/log output. |
| Inline tail lines | Lines kept inline for tail-truncated command/log output. |

### UI safety

| Setting | What it does |
| --- | --- |
| Max UI-safe text block (KB) | Hard cap on text blocks even when spill is off. |
| Max UI-safe line count | Hard line cap for rendered text. |
| Max UI-safe line width | Truncate pathological wide lines. |
| Sanitize details payloads | Cap nested tool-result details. Off by default. |

### Storage

| Setting | What it does |
| --- | --- |
| Preserve full output externally | Write oversized output to an artifact file when possible. |

### Shell minimizer

| Setting | What it does |
| --- | --- |
| Reduce verbose shell output | Compress git/npm/cargo/test output before truncation. Off by default. |
| Allowlist | Comma-separated command families to minimize. |
| Denylist | Comma-separated command families to leave alone. |
| Max capture bytes | Skip minimizer on output larger than this; truncate directly. |

## Notes

Pi's built-in tools may truncate before reaching this extension. Custom tools that return full large text benefit most from spill preservation.

For truncated file reads, continue reading the original file with `offset`/`limit`. Session `tool-results/*.json` artifacts are wrappers, not full-content recovery.
