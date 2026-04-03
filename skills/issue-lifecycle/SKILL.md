---
name: issue-lifecycle
description: "Agent workflows for issue implementation, review fix delegation, pre-submission PR review, and QA review."
license: MIT
user-invocable: true
dependencies:
  required: [orchestration, github, decider, linear]
metadata:
  author: vanillagreen
  version: "1.2.0"
---

# Issue Lifecycle

Agent workflows for issue implementation, review fix delegation, pre-submission PR review, and QA review. Designed for specialist agents receiving delegations from an orchestrator.

## Workflows

| Workflow | Agent Type | Purpose |
|----------|------------|---------|
| `workflows/dev-implement.md` | Dev agents | Full implementation lifecycle: activate → plan → implement → validate → commit → QA labels → summary → finalize (§ 1-11) |
| `workflows/dev-fix.md` | Dev agents | Process review fix items: evaluate → apply/skip → validate → commit → return |
| `workflows/pr-review.md` | Review agents | Pre-submission PR review: diff → classify findings → JSON report → verdict |
| `workflows/qa-review.md` | QA agents | QA label-triggered review: context → agent review → benchmark recording → JSON report → verdict |

## References

| Topic | Source |
|-------|--------|
| Review finding schema | Orchestration skill (`schemas/review-finding.md`) |
| Recommendation bias | Orchestration skill (`workflows/recommendation-bias.md`) |
| Label application | Project label application guide |
| Benchmark baselines | Project benchmarking skill if installed |
| Regression classification | Project benchmarking skill if available |

## Skill Dependencies

Workflows reference these companion skills and tools. Install and configure per your project:

| Dependency | Purpose | Entry Point |
|------------|---------|-------------|
| Issue tracker CLI (e.g., `linear` skill) | Issue CRUD, cache, comments, labels | `.agents/skills/linear/scripts/linear.sh` |
| Orchestration skill | Review-finding schema, recommendation-bias patterns | Referenced by name |
| GitHub skill | Git diff analysis for QA review context | `.agents/skills/github/scripts/git-diff-summary` |
| Decider skill | Decision templates, search CLI, creation workflows | `.agents/skills/decider/scripts/decisions` |
| Benchmarking | Run benchmarks if a benchmarking skill is installed | Optional |

## Execution Rules

Execute all workflow sections in order. The workflow decides what to skip via "**Skip if**" conditions — never skip based on your own scope assessment. `<delegation_format>` and `<output_format>` tags are literal templates: fill `[PLACEHOLDERS]`, omit empty lines, add nothing else, do not paraphrase.

## Configuration

This skill is workflow-based. All behavior is defined in the workflow files.

Agent types referenced in workflows (names are project-configurable):
- **Dev agents**: `[AGENT_TYPE]` — specialist agents receiving implementation delegations
- **Review agents**: `[REVIEW_AGENT]` — agents that review specific aspects (security, testing, docs, errors, structure)
- **QA agents**: `[QA_AGENT]` — agents for safety, performance, and architecture review

Commit format: `[PREFIX]([ISSUE_ID]): [DESCRIPTION]` — configurable per project conventions.
