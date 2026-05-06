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

# Publishing Pi extension packages to npm

vstack distribution is independent of npm. `vstack add`/`refresh` copies local source — npm publishing only populates the pi.dev gallery and lets external users run `pi install npm:@vanillagreen/<name>`. Skipping a publish never breaks vstack consumers.

Publish is the user's call. Do not publish proactively. When asked to publish, follow the runbook below.

## When to publish
- User-visible behavior change in the extension (new tool, new command, new setting, user-facing bug fix).
- API change that affects integration with other extensions or Pi itself.
- Skip for: refactors with no behavior change, internal cleanup, comment/typo fixes, README edits unless gallery copy needs updating.

## Versioning (semver, per package)
- patch — bug fix, no API change.
- minor — additive: new tool, new setting, backward-compatible feature.
- major — breaking: removed/renamed tool, changed setting key, dropped Pi peerDependency support.

## How to publish a single package
Token lives only in 1Password (`op://dev/x5lenzv456d5k4avuwmuwmjzdi/TOKEN`), referenced by `.env.npm` at repo root. `op run` resolves it into the spawned npm process for the duration of one command. The token is never written to disk, never logged, never in shell history.

```bash
cd pi-extensions/<name>
npm version <patch|minor|major> --no-git-tag-version   # bumps package.json only
cd ../..
git add pi-extensions/<name>/package.json && git commit -m "<name>: bump to vX.Y.Z"
cd pi-extensions/<name>
op run --env-file=../../.env.npm -- npm publish
```

After publish:
```bash
cd ../..
git tag <name>-v<version>
git push origin main <name>-v<version>
```

Then verify within ~10 minutes:
- https://pi.dev/packages/@vanillagreen/<name> (gallery picks up the keyword scrape)
- `pi -e npm:@vanillagreen/<name>` in a scratch dir (optional smoketest)

## Bulk publish (initial release or coordinated bump)
Only at intentional batch milestones. Loop the single-package flow:
```bash
cd /mnt/Tertiary/dev/vstack/main
for d in pi-extensions/*/; do
  (cd "$d" && op run --env-file=../../.env.npm -- npm publish)
done
```
Individual failures don't block siblings — review the output and re-run `npm publish` per failed dir.

## Don'ts
- Never put a literal token in any file. `.env.npm` only contains the `op://` reference.
- Never run `npm publish` outside `op run`. With no `NPM_TOKEN` in env, `.npmrc`'s `${NPM_TOKEN}` resolves empty and the publish 401s — that's the safety net. Don't "fix" the 401 by writing the token elsewhere.
- Never bump versions in `pi-extensions/*/package.json` as part of an unrelated commit. Version bumps are their own commit so the publish chain is auditable.
- Never commit `.env.npm` (it's gitignored; keep it that way).
- Never use `op run --no-masking` outside one-off auth verification. Default masking is what makes the runbook safe.
