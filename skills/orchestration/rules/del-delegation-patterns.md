---
title: Delegation Patterns
impact: CRITICAL
impactDescription: Agents receive wrong delegation or miss work entirely
tags: del
---

## Delegation Patterns

**Impact: CRITICAL (Agents receive wrong delegation or miss work entirely)**

| Pattern | When | Flow | Used by |
|---------|------|------|---------|
| New agent | Fresh delegation (dev, QA, review) | Launch agent with delegation prompt | start-worktree, review-pr, cycle-plan |
| Re-delegate | Existing agent, new work | Send new delegation to running agent | dev-fix, ci-fix, review-pr-comments |
| Self-delegate | Agent without team context | Full delegation instructions in prompt | audit-issues (TPM agent) |
| Consultation | One-off sub-agent | Full instructions in prompt, ephemeral | roadmap-plan, research-issue, start § 3 |
