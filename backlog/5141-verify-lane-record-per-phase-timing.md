---
bornAs: xu7gljj
kind: story
size: 2
status: resolved
scope: ["we:scripts/verify-lane.mjs"]
dateOpened: "2026-10-05"
dateResolved: "2026-10-05"
tags: []
---

# verify-lane: record per-phase timing

The verify marker (.git/.lane-verify) records only total start and finish. Add durations for admission wait (before startedAt), the vitest related half, the repo-scan half and the check:standards half, plus the target-file count. Operator-approved 2026-10-04.

## Done when

1. **Executable** — `npm run test:unit` over we:scripts/lib/__tests__/verify-lane-gate.test.mjs and we:scripts/__tests__/verify-lane.test.mjs — the #5141 phase-telemetry cases fail before, pass after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
