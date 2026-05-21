# Flightdeck plan-file handoff

Plan lane turns one markdown plan into multiple tracked implementation panes. The plan does not need to follow a strict header schema. Flightdeck freezes the file, analyzes it, infers work items when they are not explicit, previews the item graph once, then creates dependency-free worktrees and panes after confirmation.

## What Flightdeck accepts

- Explicit item plans: H2 sections, phase-style H3 sections, task lists, tables, or sections named `Work items`, `Implementation plan`, `Phases`, `Milestones`, `Tasks`, `Workstreams`, or similar.
- Freeform plans: narrative docs with goals, constraints, architecture, acceptance criteria, risks, validation, and rough implementation notes.
- Mixed plans: some explicit items plus extra scope that must be inferred.

Markdown headings are hints, not a contract. Unfamiliar H2 titles, `### Phase` under `## Phases`, context sections outside an allowlist, mixed H2/H3 item levels, missing worktree names, and missing dependency declarations are normal. Flightdeck decides and shows the basis in the preview instead of asking you to reformat the plan.

## Decomposition behavior

During `flightdeck plan start <path>`, Flightdeck:

1. Freezes the plan snapshot and extracts title, headings, checklists, tables, code blocks, explicit controls, and named files/modules.
2. Does light repo reconnaissance when boundaries matter, such as searching named modules or likely files.
3. Chooses one mode:
   - `explicit-items` — item boundaries are dictated by the plan.
   - `inferred-items` — items are synthesized from freeform plan content and repo context.
   - `mixed-items` — explicit items are preserved, uncovered scope is inferred.
4. Assigns item ids, worktree/branch names, dependencies, and parallel waves.
5. Sanitizes master-only orchestration instructions out of child briefs.
6. Prints one preview and asks for confirmation before any worktree, state, or pane mutation.

Flightdeck pauses before preview only when the plan is unreadable, has no meaningful implementable outcome, asks for destructive/irreversible work outside normal branch/worktree/PR flow, or contains direct contradictions where choosing an interpretation would change product behavior.

## Item controls

Controls are optional. Use them when you want to dictate boundaries; omit them when you want Flightdeck to infer.

```markdown
## Extract report model

Create a pure report model module used by current export code.

### Worktree
flightdeck-plan-report-model

### Depends on
Normalize export errors
```

Accepted control names include `Worktree`, `Depends on`, `After`, `Prerequisite`, `Blocked by`, and equivalent table columns or clear prose. Dependencies may name item titles or item ids. Worktree names become branch names. Without a worktree control, Flightdeck uses `flightdeck-plan-<item_id>`.

## Dependency and parallel inference

Flightdeck infers a dependency when one item creates an API/schema/model/storage shape used by another, two items must edit the same files or public interface in incompatible ways, generated artifacts depend on implementation output, migrations must precede consumers, or the plan says a later item builds on an earlier item.

Items with no known dependency start in the same parallel wave. When uncertain, Flightdeck prefers a conservative dependency edge over asking an open-ended question. Later merge conflict handling still verifies PR file overlap and merge order from GitHub.

## Sanitized supervisor-only context

Plan files sometimes contain instructions for the Flightdeck master, not for child implementation panes. Flightdeck removes these from child briefs and shows them in the preview as sanitized orchestration context. Markers include `BACKUP-WAKE`, reviewer fan-out instructions, `Do NOT act as Flightdeck master`, `/skill:flightdeck plan`, `$flightdeck plan`, `/flightdeck plan`, `flightdeck plan start`, `flightdeck plan watch`, `flightdeck plan close-item`, `flightdeck plan terminate`, `flightdeck linear start`, `flightdeck github start`, and `flightdeck session` commands.

Child briefs wrap the plan/item body as data and instruct the child not to execute embedded supervisor commands. A final safety scan aborts before launch if a supervisor-only marker remains in the generated brief.

## Preview shape

Before mutation, Flightdeck prints a preview like:

```text
Plan: Improve release diagnostics
Source: /repo/docs/plans/release-diagnostics.md
Mode: mixed-items
Analysis basis: explicit Phase headings plus inferred docs follow-up from Acceptance criteria
Shared context: Problem, Goals, Validation plan
Sanitized orchestration context: Execution workflow
Parallel waves:
- Wave 1: normalize-error-payloads, update-troubleshooting-guide
- Wave 2: render-diagnostics

| Item | Depends on | Worktree | Basis | Brief preview |
|------|------------|----------|-------|---------------|
| normalize-error-payloads — Normalize error payloads | — | flightdeck-plan-normalize-error-payloads | explicit phase; no file overlap found | Add shared error shape... |
| render-diagnostics — Render diagnostics | normalize-error-payloads | flightdeck-plan-render-diagnostics | depends on normalized payload API | Show normalized payload in CLI... |
```

Reject the preview if item boundaries or dependencies are wrong. Otherwise confirmation starts dependency-free items.

## Examples

### Minimal freeform plan

```markdown
# Reduce settings UI friction

Users struggle to scan the settings page. Make related toggles easier to find,
add local search by label/description, and preserve existing setting keys.

Acceptance criteria:
- Existing settings load unchanged.
- Empty search shows all settings.
- Search is case-insensitive.
- Groups have accessible headings.

Validation: run the settings UI test suite.
```

Flightdeck should infer separate items such as grouping toggles and adding search if repo reconnaissance shows independent UI/state boundaries. If both changes touch one tightly coupled settings component, it may combine them into one item and explain that in the preview.

### Explicit items with dependencies

```markdown
# Split report export pipeline

Goal: separate report serialization from delivery so future exporters can share the same core data shape.

## Extract report model

Create a pure report model module used by current export code. Keep existing exported output byte-for-byte compatible.

### Worktree
flightdeck-plan-report-model

Acceptance criteria:
- Existing export tests still pass.
- New model has unit tests for required fields.
- No delivery behavior changes.

## Add markdown exporter

Build a markdown exporter on top of the extracted report model.

### Depends on
Extract report model

Acceptance criteria:
- Markdown output includes title, summary, and item table.
- Exporter has snapshot coverage.
- Existing export behavior remains unchanged.

## Wire CLI flag

Expose a CLI flag that selects the markdown exporter.

### Depends on
Add markdown exporter

Acceptance criteria:
- Default CLI behavior unchanged.
- New flag writes markdown output.
- Invalid format names return a clear error.
```

### Phase-style plan with context

```markdown
# Improve release diagnostics

## Problem

Users need clearer failure causes across release tooling.

## Goals

Keep changes small and independently reviewable.

## Phases

### Phase 1 — Normalize error payloads

Scope: add a shared error shape.

Tests: unit tests for parser failures.

### Phase 2 — Render diagnostics

#### Depends on
Phase 1 — Normalize error payloads

Scope: show the normalized payload in the CLI.

Tests: snapshot CLI output.

## Documentation follow-ups

Update troubleshooting docs after the diagnostics wording is stable.
```

Flightdeck may treat `Problem` and `Goals` as shared context, `Phase 1` and `Phase 2` as explicit items, and `Documentation follow-ups` as an inferred dependent or parallel item depending on the plan text and repo reconnaissance. It should not stop just because `## Phases` or `## Documentation follow-ups` are not on a fixed allowlist.

## Notes

- One plan file represents one plan session.
- Dependent items spawn only after required items merge.
- Dependent items use immutable brief artifacts created at plan start; mid-session edits to the source plan do not change queued child briefs.
- GitHub merge verification happens before item cleanup.
- Mid-session edits are not re-analyzed; start a new session if the plan changes materially.
