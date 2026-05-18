# Flightdeck cleanup + dashboard settings — handoff

**For:** a fresh flightdeck master agent picking up where the previous session left off.

**State on disk:** main is at HEAD with flightdeck v2 + v3 fully merged. Vstack packages have been refreshed; the new pi session you're running in already has the simplified SKILL.md, the new plan lane, and all v3 reference docs (SCHEMA / SCRIPTS / ENV / WATCHDOGS / PROMPT-TAGS / PLAN-FILE).

**Mode:** master mode. You orchestrate. You do not implement per-issue work directly. Spawn panes for each item; review with subagents; merge through CI gates.

---

## 0. First action — backup wake timer (mandatory)

Before anything else, set up the 45-min backup wake timer. The previous session's daemon misfired twice (issues #135 and #136 in this repo). The backup timer was the only reason that session didn't stall silently for hours. Do this BEFORE you start any orchestration work:

```
bg_task spawn command:'while true; do sleep 2700; echo "BACKUP-WAKE $(date -u +%FT%TZ)"; done' \
  title:'flightdeck master backup wake-up timer (45min)' \
  notifyOnOutput:true notifyPattern:'BACKUP-WAKE' notifyMode:'always' notifyOnExit:true
```

**Diagnostic protocol on each `BACKUP-WAKE`:**

1. `flightdeck-daemon events --session <SESSION> | tail -10` — what events fired since last wake?
2. `flightdeck-daemon status --session <SESSION>` — is the daemon alive?
3. For each tracked pane: `pi-bridge state --socket <socket>` — is it idle? Did it transition since last wake?
4. If a pane reached a terminal state with NO matching daemon wake event → daemon miss-fire. File a NEW github issue with the diagnosis (look at `/run/user/$UID/flightdeck/fd-daemon-s*.log*` for evidence) and add it to the work bundle.
5. Process the actual state change, then yield again.

**Stop the timer (`bg_task stop pid:<pid>`) in your final cleanup after all merges land.** Don't leave it running across sessions.

---

## 1. Scope of work (the bundle)

Eight independent work items, no inter-dependencies. Suggested execution: use the v3 plan-file orchestration lane (`flightdeck plan start <this-doc>`) since this document IS a valid plan file under the loose convention in `skills/flightdeck/PLAN-FILE.md` — every H2 below this section is a work item. Fall back to per-issue `flightdeck github start <N>` if the plan lane misbehaves on its first real use; if you do, file an issue against the plan lane and bundle it in.

### 1.1 Seven open follow-up issues (do these first, smallest-scope-first)

Each is a single-purpose follow-up filed during or just after the previous session. Acceptance criteria for each are in the github issue body itself; consult `gh issue view <N>` for details. The work items below restate scope at the level needed to spawn a pane.

### 1.2 Two user-asked items (do these after the issues)

The README keyhint removal is a 1-2 line trim. The dashboard settings popup is a substantial Rust TUI feature — biggest item in the bundle.

---

## 2. Standards and procedure (re-state)

These are the same standards the previous session followed end-to-end. Read once, apply to every PR.

### 2.1 Orchestration

- **Use the worktree skill** to create worktrees: `.agents/skills/worktree/scripts/worktree create <name>`. Never `git worktree add` by hand.
- **Worktree naming:** `flightdeck-<short-purpose>` for fix work; `flightdeck-plan-<item_id>` if you use the plan lane and let it auto-name.
- **Spawn panes via `flightdeck-session start`** with self-contained `tmp/brief.md` prompts. No `/skill:` recursion. No `flightdeck plan start <…>` as a child prompt.
- **Model + effort:** every spawned pi pane uses `openai-codex/gpt-5.5` model and `xhigh` thinking. This was the user's directive.
- **Daemon:** start it after spawning the first pane; re-arm when respawning if it dies. `flightdeck-daemon start --session <S> --master <%PANE> --master-harness pi --inner '<%P1>,<%P2>' --inner-harnesses 'pi,pi'`. Per #136, query `pane-registry list --format inner-panes-live` for the inner list — never reuse stale values.
- **One PR per work item.** Don't bundle unrelated changes.
- **Self-contained child prompts** (no `/skill:flightdeck plan`, no `/skill:flightdeck github start`, no `$flightdeck …`). Master pre-fetches issue context via `gh issue view --json title,body,…`, writes `<worktree>/tmp/brief.md`, spawns with `flightdeck-session start --prompt "Read tmp/brief.md and execute end-to-end. Print PR URL as last line."`.

### 2.2 Review loop (per PR)

For each spawned pane that opens a PR:

1. Fan out **5 subagent reviewers in parallel** — `reviewer-arch`, `reviewer-test`, `reviewer-doc`, `reviewer-error`, `reviewer-safety`. Light scope (2 reviewers: doc + arch) for text-only PRs.
2. Each reviewer must NOT call further subagents and must NOT produce session/cycle/dashboard status. They output one `<output_format>` JSON block. Add explicit guardrails in the task prompt: "Do NOT act as flightdeck master. Do NOT produce session/cycle/dashboard status."
3. Synthesize findings. Classify as: blocker / must-fix / nice-to-have / nit.
4. If blockers exist: send ONE tight steer via `pi-bridge steer --socket <pane-socket>` with the full fix list. Include "Do NOT close + reopen the PR." Include "Print 'X complete' as LAST line and stop."
5. After follow-up commit, re-review (focused — usually just the specialty that found the most critical issues).
6. When clean: confirm CI green, merge via `gh pr merge <N> --squash --delete-branch`.

### 2.3 Merge gates

- `mergeStateStatus === "CLEAN"` required for auto-Merge (per github lane v2 design).
- `FLIGHTDECK_AUTO_MERGE=0` would gate all merge-answering paths; default `=1` and auto-merge is fine since user gave explicit authorization for this bundle.
- Squash + delete branch.
- Pull main with `--ff-only` after each merge. If git refuses due to local untracked plan/handoff doc, remove the local copy first (origin has it).

### 2.4 Doc standards (enforced)

- **READMEs are user-facing only.** No implementation jargon, no schema details, no internal env vars. Move technical content to DEVELOPMENT.md or the v2 reference doc siblings (SCHEMA/SCRIPTS/ENV/WATCHDOGS/PROMPT-TAGS).
- **No project-specific references** in `skills/`, `agents/`, `hooks/`, `pi-extensions/` shipped code/docs. Use `<N>`, `<REPO>`, `<ITEM_ID>` placeholders.
- **Docs and instruction payloads ship with the code change** — every behavior change updates affected READMEs, AGENTS.md, vstack.toml, .env.local.example, package.json, instruction payloads, and any cross-referencing docs **in the same commit**.
- **Never edit mirror dirs** (`.agents/`, `.pi/`, `.claude/`, `.opencode/`, `.codex/`). They regenerate via `vstack refresh`.
- **CLI version + GitHub release tag** stay synchronized; don't bump versions without explicit ask.

### 2.5 Pi extension development workflow

For any change under `pi-extensions/**`:

1. Validate the new code is reachable from where it's invoked.
2. Commit intended pi package changes.
3. After commit, run `vstack refresh -g` so global install picks up committed source state. If the worktree is on a feature branch, the refresh source index may still point at `main` — note this in the PR body honestly.
4. Don't claim done until commit + refresh complete.

### 2.6 Parity tests for flightdeck-core

Before any commit touching `skills/flightdeck/lib/flightdeck-core/`, run:

```
cd skills/flightdeck/lib/flightdeck-core && bun test && bun run typecheck
```

Both must pass. Add tests for any new behavior. Existing parity tests must keep passing.

### 2.7 Recursion invariant for new flightdeck lanes

If a work item touches `skills/flightdeck/scripts/` or `skills/flightdeck/workflows/`, run this grep before commit:

```
grep -rnE '/skill:flightdeck (plan|github|linear) (start|watch|close|terminate)|\$flightdeck (plan|github|linear) (start|watch|close|terminate)|/flightdeck (plan|github|linear) (start|watch|close|terminate)' \
  skills/flightdeck/scripts/ skills/flightdeck/workflows/ skills/flightdeck/lib/flightdeck-core/src/
```

Zero hits required. Master-side workflows must NEVER emit those as child prompts.

### 2.8 Newly-discovered issues during work

If you spot a real bug during execution — daemon misfire, pane wedge, regression, security concern, etc. — **file a GitHub issue and add it as a new work item** to this bundle. Sequence it at the end of the bundle unless it blocks current work.

Patterns to watch for (from the previous session's hard-learned lessons):

- **Daemon misfires:** any `BACKUP-WAKE` wake where a state change happened with no corresponding daemon event → file. Cross-reference #135 / #136 if related.
- **Pane wedges:** session JSONL stops writing while `isIdle=false` and the pi process is alive. Master applies fix inline + files an issue against pi-agents-tmux.
- **Apply_patch failures with no toolResult:** the previous session's `pi-bridge-skill-dedup` pane wedged this way. If you see it, kill the pane, apply the intended changes via master's own file edits, file an issue.
- **Over-renames:** the v2 phase-3 pane initially renamed daemon wake-payload references that shouldn't have been renamed. Always review what's a USER COMMAND vs an INTERNAL CONSTANT before applying broad text changes.

---

## 3. Work items

The 6 follow-up issues are smaller; do them first (in any parallel-safe order). Items 7 and 8 are the user-asked additions — README trim is trivial, dashboard settings popup is substantial.

---

## Fix issue #126 — rate-limit watchdog observability

Add a low-noise per-decision activity row when the rate-limit watchdog rejects an event (i.e., classifies a message_end as not-rate-limited). Today the watchdog emits activity only on positive detection; rejections are invisible, so a future SDK shape drift would silently never trigger recovery.

### Scope

Read the full issue body: `gh issue view 126 --repo vanillagreencom/vstack`. Implementation lives in `skills/flightdeck/lib/flightdeck-core/src/daemon/rate-limit-watchdog.ts` and the vendored mirror in `pi-extensions/pi-agents-tmux/extensions/subagent/rate-limit-decision.ts`. Both copies must change in lock-step. Add a parity test asserting the new activity row fires on classifier rejections (with reason: `non-assistant` | `no-stopreason` | `stopreason-mismatch` | `no-prose`).

### Acceptance criteria

- New activity row `subagents:rate_limit_skipped` (or similar — match existing naming) emitted by both canonical + vendored decision modules on each classifier rejection, including a `reason` field categorizing the rejection.
- Parity tests cover all 4 reasons.
- Existing tests still pass.
- SKILL.md / WATCHDOGS.md / SCRIPTS.md updated if the new activity tag warrants documentation.

### Worktree

flightdeck-issue-126-rate-limit-obs

---

## Fix issue #129 — pi-session-bridge cache eviction + bound

The per-session skill-expansion cache added in PR #127 has no eviction on session end and no size bound. For a long-running pi-bridge process across many sessions, the map accumulates indefinitely.

### Scope

`pi-extensions/pi-session-bridge/extensions/session-bridge.ts` — `loadedSkillHashesBySession`. Add a `pi.on("session_shutdown", ...)` (or whatever pi's session-end hook is named — grep for it) to drop the matching session's sub-map. Optionally add an LRU cap on the outer Map (last 100 sessions) as belt-and-braces.

### Acceptance criteria

- Session-end eviction wired.
- Unit test: register 2 sessions in cache, fire session-shutdown for one, assert only its sub-map is gone.
- Optional LRU cap if straightforward.
- Pi extension workflow: commit, `vstack refresh -g`, verify, document in PR body.

### Worktree

flightdeck-issue-129-cache-eviction

---

## Fix issue #130 — pi-agents-tmux subagent stale-cwd handling

A subagent pane retains its original cwd when reused for a follow-up task with a different cwd argument; the pi process never chdirs. If the orchestrator removed the original worktree, the next spawn inside that pane ENOENTs on cwd.

### Scope

`pi-extensions/pi-agents-tmux/extensions/subagent/` — the dispatch + runner code paths. Two viable fixes (per the issue):

1. **Conservative:** before queuing a task into an existing pane, check `readlink /proc/<pid>/cwd` and refuse with a structured `pane-cwd-stale` error if the path is gone or doesn't match the task's `cwd`. Orchestrator handles via `stop_subagent` + retry with `forceSpawn`.
2. **User-friendly:** when dispatched `cwd` doesn't match pane's cwd, emit `cd <new_cwd>` to the pane's shell (or re-launch pi with new cwd).

Pick option 1 — it's smaller, safer, and surfaces the staleness clearly. Document the structured error in the extension's instructions.md.

### Acceptance criteria

- Pre-dispatch cwd staleness check implemented.
- Structured `pane-cwd-stale` error returned + activity row emitted.
- Unit test or integration test using `mkdtemp` + `rmSync` to simulate the stale-cwd scenario.
- PR #124's pi-claude-bridge cwd preflight handles the symptom; this issue handles the root cause. Cross-reference in PR body.

### Worktree

flightdeck-issue-130-stale-cwd

---

## Fix issue #133 — pane/window name sync

Three independent labels for the same pane (registry's spawn title, tmux's auto-rename, master's internal shorthand) don't agree. User has no way to map "C/A2 pane" shorthand to anything they see in tmux or the dashboard.

### Scope (three-layer fix from issue body)

1. **Master output discipline** (cheap, no code): SKILL.md rule that master must refer to panes by their tracked-entry `id` in every user-visible message. No internal shorthand. Add as a one-line rule in `skills/flightdeck/SKILL.md` Implementation Constraints.
2. **Registry title refresh** (small TS change): `pane-poll` and the daemon reconcile loop already read live pane state. Have them also read `tmux display-message -p -t <pane> '#W'` and write it to a new optional `entry.window_name_current` field. Dashboard renders the current name. Master state schema (SCHEMA.md) updated.
3. **tmux auto-rename guard** (one-liner, opt-in): `flightdeck-session start` adds `tmux set-window-option -t <window> automatic-rename off` after creating the window. Gate behind `FLIGHTDECK_DISABLE_AUTO_RENAME=1` (default off so we don't surprise existing users).

### Acceptance criteria

- All three layers landed.
- Parity test for the registry refresh field.
- ENV.md documents the new env flag.
- SCHEMA.md documents `entry.window_name_current`.

### Worktree

flightdeck-issue-133-name-sync

---

## Fix issue #135 — daemon subscriber spawns with wrong pi_pid

The pi-subscriber spawned for a newly-tracked pane received the pi_pid of an ALREADY-tracked pane (a different one's pi process). Subscriber connected to the wrong pi-bridge socket and never saw events from its actual target.

### Scope

`skills/flightdeck/lib/flightdeck-core/src/daemon/` (probably the reconcile / subscriber-spawn path) — discovery for a freshly added pane should require `/proc/<pi_pid>/cwd` to resolve inside the tracked entry's `entry.cwd` AND the discovered pi session id to match the entry's recorded `adapter.pi_session_id`. Mismatch → re-probe at next reconcile tick, don't cache the wrong answer.

Belt-and-braces: after subscriber spawn, the subscriber's first event should include the connected pi session id. The daemon hash-compares against the tracked entry's recorded session id. Mismatch → kill subscriber, re-spawn with correct args.

### Acceptance criteria

- Discovery requires cwd + session id match before accepting.
- Subscriber emits `pi-session-id` on connect; daemon compares.
- Integration test simulating two panes with similar-looking pi processes; assert correct binding.

### Worktree

flightdeck-issue-135-subscriber-pid

---

## Fix issue #140 — pi-flightdeck banner shows stale tracked sessions

On fresh pi session start in a repo with a leftover `tmp/flightdeck-state-<TMUX_SESSION>.json` containing tracked entries whose pane_ids are dead in tmux, pi-flightdeck renders a misleading `● daemon standby · N tracked sessions — run /skill:flightdeck session watch to start supervising.` banner. There's nothing to supervise.

### Scope

`pi-extensions/pi-flightdeck/extensions/flightdeck.ts:280-292` (the `awaiting-watch` branch) — filter tracked entries by tmux pane_id liveness before counting. If all entries have dead pane_ids, fall through to the existing `No tracked sessions yet` / hidden-banner path. Optionally auto-archive the state file on read when this condition holds (mirrors the `flightdeck-session start` auto-archive trigger documented in SKILL.md).

### Acceptance criteria

- Banner suppressed when every tracked entry's pane_id is not in `tmux list-panes -a -F '#{pane_id}'` output.
- Daemon chip itself unchanged.
- New test under `pi-extensions/pi-flightdeck/tests/` for the stale-pane-id-filtered-to-zero case.
- Pi extension workflow: commit, `vstack refresh -g`, verify, document in PR body.

### Worktree

flightdeck-issue-140-stale-banner

---

## Fix issue #136 — daemon max-lifetime stale-pane respawn

The daemon's 4-hour max-lifetime self-respawn handed the successor an inner-pane list that included a pane id reaped HOURS earlier. Successor died immediately on inner-pane resolution.

### Scope

`skills/flightdeck/lib/flightdeck-core/src/bin/flightdeck-daemon.ts` (the respawn / handoff code path) — at handoff time, re-query the live tracked panes via `pane-registry list --format inner-panes-live` (the documented source). Pass that list to the successor, NOT a captured snapshot. If `panes=0`, successor starts with empty list and discovers via reconcile.

### Acceptance criteria

- Successor's `--inner` argv assembled from live re-query at handoff.
- If inner list still contains a now-dead pane id, downgrade to warning + drop the entry (don't fatal-error).
- Integration test: start daemon with 3 inner panes, kill some, fast-forward MAX_LIFETIME, assert successor starts cleanly.

### Worktree

flightdeck-issue-136-respawn-stale

---

## Remove keyhints from flightdeck README.md

User-facing README should describe what flightdeck IS, not list every keyboard shortcut. The current `Useful keys:` block (line ~121 of `skills/flightdeck/README.md`) is dashboard implementation detail.

### Scope

`skills/flightdeck/README.md` — find the keyhint listing and remove or move it. If the keys are documented elsewhere (DEVELOPMENT.md or the dashboard's own help popup), point to that. If not, just remove.

### Acceptance criteria

- Keyhint block removed from README.
- README still describes the dashboard at a high level (what it shows, how to launch it). No key-by-key documentation.
- Reference to the in-app help popup if one exists ("press `?` in the dashboard for keys" or similar).

### Worktree

flightdeck-readme-trim-keys

---

## Add dashboard settings popup (substantial)

User asked: make all flightdeck env vars / app settings editable from inside the Rust TUI dashboard via a settings/options popup. If a setting requires restart, the popup informs the user it won't take effect until a new flightdeck session.

### Scope

This is a substantial Rust TUI feature. Implementation lives in `skills/flightdeck/lib/flightdeck-dashboard/src/`. Spend the first 15 minutes studying the existing popup infrastructure (help / theme / filter / detail / confirm popups — search for `popup` in the source). Match the existing pattern.

Surface area:

1. **Settings catalog.** Read every env var documented in `skills/flightdeck/ENV.md`. Group by category (master-loop / watchdog gates / daemon hygiene / dashboard / additional tuning). Each entry: name, current value, default, purpose, restart-required-flag.
2. **Read current values.** From `std::env::var` at dashboard startup. If a value is set, show it; if unset, show the default in muted color.
3. **Edit affordance.** From the settings popup, user can edit string values via an inline edit box (re-using the existing search-line widget pattern). Boolean toggles via Space/Enter. Numeric values via inline edit.
4. **Persist edited values.** Write to a local override file: `<project-root>/tmp/flightdeck-settings.toml`. On dashboard startup, this file's values override env defaults. (Don't try to mutate the parent shell's env — impossible from a child process.)
5. **Restart-required flag.** Some settings (anything daemon-level, anything dashboard-startup-only like motion/theme) requires a new flightdeck session. Tag those in the catalog. When the user edits a tagged setting, show a banner: "Will take effect on next `flightdeck session start` / dashboard launch."
6. **Settings catalog file.** Add `skills/flightdeck/lib/flightdeck-dashboard/src/settings_catalog.rs` (or similar) with a typed struct per setting. Source of truth for the popup. Update if new env vars are added in the future.

### What stays read-only

- `FLIGHTDECK_ENTRY_ID` — auto-set by flightdeck-session, never user-editable.
- `FLIGHTDECK_DASHBOARD_READY_FD` — internal IPC fd.
- Test-only env vars (`FLIGHTDECK_DASHBOARD_TEST_*`) — exclude from the popup entirely.

### Acceptance criteria

- New `Settings` popup accessible from a documented key (consult existing pattern; probably `s` or alt+`s`).
- Catalog covers every editable env var in ENV.md.
- Edited values persist to a local override file.
- Restart-required settings flagged with a clear banner.
- Cargo build + cargo test clean.
- New keys documented in the dashboard's `?` help popup (NOT in the README — per the README-keyhint-removal item above).
- ENV.md notes that settings are also editable from the dashboard.

### Worktree

flightdeck-dashboard-settings-popup

### Dependencies

This is the biggest item — keep it as the LAST work item in the bundle so any issues fixed earlier (especially issue #133, which touches `pane-poll` / `flightdeck-session` and may affect dashboard reads) are merged first.

---

## 4. Execution recipe

If using the v3 plan lane (recommended):

```
# After spawning your own master pane (which is you, the new agent)
# and setting up the backup timer (step 0 above), run:
flightdeck plan start docs/plans/flightdeck-cleanup-and-dashboard-settings-handoff.md
```

The plan lane will parse this document, identify the 8 H2 items above (under section 3), confirm the items + worktree names with you, and start spawning panes.

If the plan lane misbehaves on its first real run:

1. Stop the plan lane.
2. File an issue against the plan lane describing the misbehavior.
3. Fall back to per-item orchestration: `flightdeck github start <N>` for the 6 issues, then manual worktree+pane for the 2 user-asked items.
4. Add the plan-lane issue to the bundle.

---

## 5. Done definition

- All 6 follow-up issues (#126, #129, #130, #133, #135, #136) closed via merged PRs.
- README keyhint removal merged.
- Dashboard settings popup merged.
- Any newly-discovered issues filed AND either fixed or deliberately deferred (with reasoning in the issue body).
- BACKUP-WAKE timer stopped.
- Daemon stopped.
- All worktrees + spawned panes cleaned up.
- Main synced; `git status` clean except pre-existing untracked plan docs.
- End-of-session summary delivered to user (similar shape to the previous session's summary: merged PRs table, filed issues table, sharp edges, architecture notes).

---

## 6. Context the previous session built up (skim, don't memorize)

For background only; don't re-derive these:

- **Flightdeck v2 architecture** is now four lanes: `linear` / `github` / `session` / `plan`. SKILL.md is 237 lines (down from 453); reference docs (SCHEMA / SCRIPTS / ENV / WATCHDOGS / PROMPT-TAGS / PLAN-FILE) hold the detail.
- **`entry.domain`** is a mutually-exclusive union of `issue` (linear) / `github_issue` (github) / `plan_item` (plan). Validator rejects multi-domain entries on both `write-entry` and raw `setEntryField` paths (per the v3 hardening commit `517fd332`).
- **Eight PR#134 lessons-learned** apply to every new flightdeck lane addition: no recursion, separate domain key, CLEAN merge gate, authoritative gh verification before close, watch UNKNOWN + gh-CLI failure handling, strict force-merge predicate, native adapters not tmux fallback, placeholders not literals.
- **Pi-session-bridge skill expansion is deduplicated per session** (PR #127). Repeated `/skill:<name>` sends in one pi session emit a one-line reminder. Content-hash invalidates; bridge restart clears. You're benefiting from this right now — that's why you don't see SKILL.md re-emitted on every daemon wake.
- **Daemon watchdog patterns:** rate-limit / agent-end / idle-stall / edit-loop. All four toggleable via `VSTACK_*_WATCHDOG=0`. See WATCHDOGS.md.

---

## 7. Anti-patterns to avoid (hard-won)

- **Don't merge a PR with reviewer-flagged blockers under time pressure.** The previous session re-spawned PR #132 to address blockers up-front in PR #134; that was the right call.
- **Don't trust pane buffer text as authoritative state.** A pane saying "MERGED" doesn't mean the PR is merged — call `gh pr view` and check `state` + `mergeCommit`.
- **Don't rename internal constants alongside user-facing commands.** The v2 phase-3 pane initially renamed wake-payload constants in 3 doc files; reviewer-arch + reviewer-doc caught it, master applied a 3-line revert. Always distinguish "user types this" from "code emits this internally."
- **Don't kick off `flightdeck plan start` on a plan file that hasn't been DRY-RUN previewed.** The v3 plan start workflow has an explicit dry-run preview step for exactly this reason. Confirm parsed items + dependencies + worktree names before any worktree mutation.
- **Don't leave the BACKUP-WAKE timer running across sessions.** Stop it in final cleanup.
- **Don't ignore daemon `daemon-exited` events.** They mean wake delivery is broken until you restart it. Cross-reference issues #135 / #136 for the two known causes.
