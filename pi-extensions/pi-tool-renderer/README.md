# pi-tool-renderer

Compact renderers for built-in Pi tools.

This package re-registers built-in tools with the same names and delegates execution to the original Pi implementations. It changes only `renderCall`/`renderResult` so `Ctrl+O` remains Pi's expand/collapse mechanism.

It targets `read`, `bash`, `edit`, `write`, and, when the current Pi runtime exports factory helpers for them, `grep`, `find`, and `ls`.
