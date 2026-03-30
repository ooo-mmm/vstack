---
title: Metric Kind Migration Backfill
impact: HIGH
impactDescription: Missing baseline causes false "no regression data" errors after metric kind change
tags: recording, metric, migration, backfill
---

## Metric Kind Migration Backfill

**Impact: HIGH (missing baseline causes false "no regression data" errors after metric kind change)**

**Symptom**: `bench.sh regression <component>` outputs "No baseline commit reachable from HEAD" or shows "metric missing" for all operations — this often means historical data uses a different `metric_kind` than the current recorder.

**Fix**: Backfill records for the relevant ancestor commit using the old metric values in the new metric kind format.

Key points:

- Backfill must cover **ALL variant operations** for that commit — including secondary variants — not just the primary operations. Missing variants cause false regression errors.
- `bench.sh record <component> '<json>'` writes the file with the current HEAD in the filename but preserves the specified `commit_hash` in the JSON content (which is what regression detection reads).
- After backfilling an ancestor, record a fresh result for the current HEAD so the regression command has two commits to compare.
- The original metric-kind files remain in place; new records supersede them (the store picks the entry with the latest timestamp).
