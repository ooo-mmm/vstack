# pi-output-policy

OMP-style large-output policy for Pi tool results.

- Preserves full oversized output in `.pi/artifacts/output-policy/` when possible.
- Uses head truncation for read/search/listing tools and tail truncation for command/log tools.
- Adds explicit truncation notices with size, line, direction, and artifact path details.
- Applies a simple shell-output minimizer before hard truncation.
- Sanitizes text blocks and details payloads for UI safety.

Limit: Pi's built-in tools may already truncate before `tool_result`; this extension can only preserve the result text it receives. Custom tools that return full large text benefit most from spill preservation.
