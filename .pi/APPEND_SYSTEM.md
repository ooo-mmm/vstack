# Vstack Pi UI rules

For Pi extension UI changes:
- First inspect multiple `pi-extensions/*` packages; match existing patterns.
- Popups: title in top border (`\x1b[32m`); tabs then blank line; search = full-width `toolPendingBg` row, `> [cursor]`, no hint; footer owns key hints (`\x1b[33m`); active rows `selectedBg`+text; matches `\x1b[31m`; no decorative cursors.
- Tool rendering: compact one-line calls; bold label, accent target, muted metadata; tree children; success/error/warning status colors; raw output/diffs only when useful or expanded.
- Persistent banners below status: framed, compact counts in header, tree rows, active first, muted hints, collapse/clear when empty.

# Vstack Pi extension development workflow

For any `pi-extensions/**` or Pi package behavior change:
1. Validate before finishing — confirm new code is reachable from where it's invoked. Cross-extension calls: `pi.getCommands()` is metadata only; bridge via `globalThis[Symbol.for("vstack.pi.<topic>")]` (see modal-lock, thinking-timer, question-service for examples). If you can't live-test in Pi, say so.
2. Commit intended Pi package changes unless user says not to.
   - Stage only intended files; leave unrelated dirty files untouched and mention them.
   - If signing fails, retry with `--no-gpg-sign`.
3. After commit, immediately run `vstack refresh -g` so the global Pi install picks up committed source state. (`vstack refresh` without `-g` defaults to all scopes; `-g` narrows to global, which is what we want for Pi extension dev.)
   - Refresh after commit, not before.
   - Report commit hash and refresh result.
4. Do not say done/fixed/committed/ready to test until commit + refresh are complete. If skipped, say so and why.

Worktree/feature branch dev: test via local project Pi settings for that checkout; do not add vstack repo sources pointing at temp/worktree paths.

General `vstack add` scope rules apply (see [AGENTS.md](../AGENTS.md#rules)).
