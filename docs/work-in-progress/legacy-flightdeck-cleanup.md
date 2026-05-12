# Legacy flightdeck cleanup — execute after one stable production cycle

Two-phase cleanup of legacy bash artifacts and opt-in/opt-out gating left
behind by the flightdeck bash→TS port (merged in commit `29d9355`). Each
phase has explicit gates; do NOT skip them.

Worktree: `/mnt/Tertiary/dev/vstack/main` (or any worktree on `main`).
Target: branch off `main`, do the work, push, PR, merge.

## Phase A — `.bash` siblings + trampoline simplification

### Gate before starting Phase A

ALL of these must be true:

- [ ] At least one stable flightdeck production session has run end-to-end
  on the TS default trampolines (i.e. with no `FLIGHTDECK_USE_TS_*=0`
  overrides anywhere).
- [ ] `bun test` in `skills/flightdeck/lib/flightdeck-core/` passes
  cleanly (`cd skills/flightdeck/lib/flightdeck-core && bun test`).
- [ ] `bun run typecheck` clean in the same dir.
- [ ] `skills/flightdeck/tests/live-wake.sh` green under default
  (no `--use-ts` flag needed since TS is default).
- [ ] No open GitHub issues against the flightdeck TS port that flag
  observable regressions vs the bash bodies. Open issues that document
  divergences (e.g. adapter-fallback timing, max-lifetime PID change)
  are fine — those are deliberate.

### Steps

1. **Delete `.bash` sibling scripts:**
   ```
   git rm skills/flightdeck/scripts/{prompt-classify,flightdeck-state,parallel-groups,pane-registry,pane-poll,pane-respond,flightdeck-daemon}.bash
   ```
   (7 files.)

2. **Simplify trampolines.** Each `scripts/<name>` is currently a
   dispatcher that selects bash vs TS via env. Replace each with a
   minimal `exec bun ...` form. Example (after the diff, the file is
   ~15 lines):
   ```bash
   #!/usr/bin/env bash
   # TypeScript implementation of flightdeck-<name>.
   # See skills/flightdeck/lib/flightdeck-core/src/bin/<name>.ts.
   set -euo pipefail
   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
   exec bun "$SCRIPT_DIR/../lib/flightdeck-core/src/bin/$(basename "${BASH_SOURCE[0]}").ts" "$@"
   ```
   Apply to all 7 files (`prompt-classify`, `flightdeck-state`,
   `parallel-groups`, `pane-registry`, `pane-poll`, `pane-respond`,
   `flightdeck-daemon`).

3. **Remove the `FLIGHTDECK_USE_TS_DAEMON_START` opt-in gate.** The
   daemon `start` action defaulted to bash via a per-action env gate
   pending one production cycle on TS. After that cycle:
   - In `src/bin/flightdeck-daemon.ts`, remove the
     `FLIGHTDECK_USE_TS_DAEMON_START` env check; route `start` to
     `src/daemon/start.ts` unconditionally.
   - Anywhere in docs that references this flag, remove the reference.
     Files to check: `skills/flightdeck/SKILL.md`,
     `skills/flightdeck/README.md`, `tests/README.md`,
     `workflows/watch.md`, `workflows/start.md`.

4. **Decide on `scripts/lib/subscribers.bash`.** This file holds the
   per-harness subscriber loop bodies, shared between the (deleted)
   bash daemon and the TS daemon's `spawn_<h>_subscriber` paths. The TS
   daemon currently spawns these bash bodies via `Bun.spawn`. Two
   options:
   - **(a) Keep as-is.** TS daemon continues to spawn bash subscriber
     bodies. Simpler, less code change. Pre-existing pattern; works.
   - **(b) Port natively to TS** under `src/daemon/subscribers/{oc,cc,pi,cx}.ts`.
     More work; eliminates the shared bash file and one set of process
     forks per subscriber spawn. Not urgent.
   - Recommendation: **(a)** for this phase. File a follow-up issue
     for (b) as a perf optimization to land independently.

5. **Update tests under `tests/parity/`.** These tests run the bash
   sibling + the TS impl with the same input and assert equivalent
   output. After Phase A, the bash siblings are gone — parity tests
   either need to:
   - **(a) Delete entirely.** TS impl now stands alone; unit tests
     under `tests/unit/` cover the behavior. (Need to verify coverage
     is sufficient before deletion.)
   - **(b) Convert to fixture-based snapshot tests.** Keep the inputs,
     replace the bash-baseline assertion with snapshot files containing
     the expected output. Catches regressions in the TS impl without
     needing a bash counterpart.
   - Recommendation: **(b)** for prompt-classify (the regex matcher
     where snapshot-style is natural). **(a)** for the rest (CLI-shape
     tests covered by unit tests; the parity-against-bash specific
     scaffolding adds no value once bash is gone).

6. **Doc cleanup pass.** In each file, remove "opt out via
   `FLIGHTDECK_USE_TS_<NAME>=0`" language. The trampolines now have
   one path; the legacy is gone. Files:
   - `skills/flightdeck/SKILL.md` — Scripts table, Configuration env vars
   - `skills/flightdeck/README.md` — Daemon tuning, Scripts, Tests,
     Operational caveats sections
   - `skills/flightdeck/tests/README.md` — TS parity tests language
   - `skills/flightdeck/workflows/start.md` — bun preflight reference
   - `skills/flightdeck/workflows/watch.md` — daemon `start` caveat
   - `skills/flightdeck/patterns/tmux-monitoring.md`
   - `skills/flightdeck/patterns/prompt-handlers.md`
   - `pi-extensions/pi-flightdeck/README.md`

   `bun` is now an unconditional hard runtime dependency (was
   "conditional during the transition"). README/SKILL system
   requirements should reflect that.

7. **`.env.local.example` / any env-defaults docs.** Check for stale
   references to `FLIGHTDECK_USE_TS*` env vars; remove them.

8. **Verify and commit.** Single commit per logical group (one for
   `.bash` deletion + trampoline simplification, one for `start` gate
   removal + tests update, one for the doc sweep). Run:
   ```
   cd skills/flightdeck/lib/flightdeck-core && bun test && bun run typecheck
   skills/flightdeck/tests/live-wake.sh
   ```
   Both green before push.

### Phase A success criteria

- `find skills/flightdeck/scripts -name '*.bash'` returns nothing.
- `grep -r FLIGHTDECK_USE_TS skills/flightdeck/` returns nothing
  (or only obviously stale historical references in docs/work-in-progress).
- Tests pass, live-wake green.

## Phase B — post-#13 cleanup (only after #13 ships)

### Gate before starting Phase B

ALL of these must be true:

- [ ] vstack#13 (pi-session-bridge hybrid slash dispatch) has shipped
  and one stable production cycle has run on it.
- [ ] `pi-bridge send "/skill:flightdeck watch --from-daemon"` to a pi
  master is empirically known to dispatch correctly (inline expansion
  via Route 1).
- [ ] Phase A is complete.

### Steps

1. **Remove the daemon's `/flightdeck` bare-extension-command
   workaround.** The wake payload reverts to the canonical form:
   - In `skills/flightdeck/lib/flightdeck-core/src/daemon/wake-payload.ts`:
     change the pi branch from `/flightdeck watch --from-daemon` back
     to `/skill:flightdeck watch --from-daemon`. (After #13, pi-bridge
     expands `/skill:` correctly via Route 1, so the canonical form
     dispatches without needing the bare-extension-command hop.)
   - Remove the per-harness divergence comment.

2. **Remove the `/flightdeck watch` re-dispatch handler in pi-flightdeck.**
   In `pi-extensions/pi-flightdeck/extensions/flightdeck.ts`, the
   `pi.registerCommand("flightdeck", { handler })` body has a special
   case that parses `watch [args]` and re-dispatches via
   `ctx.ui.pasteToEditor("/skill:flightdeck watch ...\n")`. After #13
   makes the canonical `/skill:flightdeck watch --from-daemon` dispatch
   via the bridge, this handler doesn't need that branch — restore the
   simpler "open popup" behavior:
   ```ts
   pi.registerCommand("flightdeck", {
     description: "Open the flightdeck mission-control popup.",
     handler: async (_args, ctx) => openPopup(pi, ctx),
   });
   ```

3. **Remove `/bridge:ping` dual registration in pi-session-bridge.** If
   #13's implementer didn't already do this — the manual
   `pi.on("input", ...)` interceptor for `/bridge:ping` in
   `pi-extensions/pi-session-bridge/extensions/session-bridge.ts` is
   redundant once Route 2 (tmux paste fallback) handles extension
   commands. Remove the interceptor; keep only `pi.registerCommand`.

4. **Daemon wake fallback — `send-keys -l` swap (only if #13's
   verification proved paste-buffer doesn't work).** The acceptance
   criterion #8 added to #13 may have already done this. If not:
   - In `flightdeck-daemon.bash` (if still present after Phase A — it
     shouldn't be) and `src/daemon/wake.ts`, replace the
     `load-buffer` + `paste-buffer` body with `send-keys -l` for the
     pi-master fallback path. Pattern in #11's body for reference.

5. **Doc cleanup pass.**
   - Remove references to "bare /flightdeck workaround" or "#9
     workaround" in flightdeck docs.
   - Update `pi-extensions/pi-session-bridge/README.md` "Slash command
     behavior" section: the matrix changes once #13 lands. All slash
     commands now dispatch via pi-bridge. Update the table to reflect
     this.
   - Remove the "Known limitations" section in
     `pi-extensions/pi-flightdeck/README.md` (the bridge bypass
     limitation that #10 documented).

6. **Close out #9 + #10 cleanup.** Verify both issues are closed on
   GitHub with comments pointing at the resolving commits.

### Phase B success criteria

- Daemon wake payload uses canonical `/skill:flightdeck watch --from-daemon`
  for pi masters.
- `pi-flightdeck`'s `/flightdeck` command handler is the simple popup
  opener.
- `pi-bridge send "/skill:foo"` works for any pi extension's skill.
- All docs reflect the post-#13 universal dispatch model.

## General rules

- **One PR per phase.** Don't mix Phase A and Phase B in one commit
  range. Each phase has its own production-cycle gate.
- **`git rm` not `rm`.** Stay on top of git's tracking.
- **No `git add -A`.** Stage each change explicitly. The repo has
  unrelated WIP that can sneak in.
- **`--no-gpg-sign`** if signing fails.
- **Run the test suite before every commit.**
- **Don't push without external sign-off.** Same protocol as the
  original port.
- **Watch for stragglers.** After each phase, `grep -ri
  flightdeck_use_ts skills/flightdeck/` and `grep -ri
  '\.bash' skills/flightdeck/` to catch any references missed in the
  sweep. Anything in `docs/work-in-progress/*` can stay (historical
  record); production docs should be clean.

## Out of scope for this cleanup

- The native-TS subscriber port (Phase A item 4 option b). File as a
  separate perf-optimization issue.
- The `pi-bridge` slash dispatch fix itself (vstack#13). That's its
  own PR; Phase B depends on it shipping.
- Documentation of the pi-mono upstream constraint (#10 closeout
  doc already covers this).
