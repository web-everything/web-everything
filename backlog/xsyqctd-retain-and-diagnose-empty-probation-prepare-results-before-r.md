---
kind: task
status: open
scope: ["we:scripts/operations/probation-build-run.mjs"]
dateOpened: "2026-09-30"
tags: []
---

# Retain and diagnose empty probation prepare results before releasing holds

Prepare items #4319, #4322 and #4561 returned zero-file diffs on 2026-09-30. The retained run records and delivery logs say only prepare requires a card-only diff. Recover the worker terminal evidence, establish why no card was authored, and add a regression before releasing these items or the Codex prepare route. PR #3051 improves future diagnostics but does not establish the cause of these three attempts.

## Done when

1. Add a regression reproducing the observed refusal from its original launch context; demonstrate red before the cause fix and green afterward.
2. Retain the terminal evidence and cite the removing commit in the reviewed prepare release manifest.
3. Keep the affected prepare hold until both evidence and regression are reviewable.
