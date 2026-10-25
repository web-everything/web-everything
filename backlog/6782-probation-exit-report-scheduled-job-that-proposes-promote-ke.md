---
bornAs: xov32df
kind: story
size: 3
status: open
scope: ["we:scripts/lib/model-probation.mjs"]
dateOpened: "2026-10-21"
tags: []
---

# Probation-exit report: scheduled job that proposes promote / keep-with-filter / drop for each advisory review seat

Probation had no exit rule: `we:scripts/lib/model-probation.mjs` never moves a lens out of ADVISORY_LENSES, so advisory seats ran for 14+ days with no decision. Add a scheduled report job, built from the scorecard, that gives every advisory/probation seat an exit.

After N seats or D days (e.g. 500 seats / 7 days) the report proposes promote / keep-with-filter / drop per seat and raises it to the operator as a ready-to-ratify decision. A seat with no decision by the deadline is paused (tokens stop), never silently continued.

## Acceptance

- [A1] **Executable** — tests: a seat past N seats or D days produces a proposal and a filed decision card; a seat past the deadline with no ruling is paused.
- [A2] **Executable** — a paused seat makes no provider calls, and the pause reason is logged.

## Non-goals

- [N1] Does not decide promote/drop itself; the operator ratifies.
- [N2] Does not change the mandatory seats.

## Edge cases this change must handle

1. **Untrusted text** — scorecard fields are quoted as data in the proposal, never interpreted.
2. **Truncated reads** — a partial scorecard read aborts the run; no proposal from partial data.
3. **Shared state files** — the report only reads the scorecard; its own state (deadlines) is written atomically.
4. **Fail closed** — if the job cannot run, seats still pause at their deadline.
5. **Identity scoping** — thresholds and deadlines are per lens and per provider.
6. **State over time** — the deadline clock starts at first seat; a ruling resets it; a re-run does not file duplicate decisions (idempotent).
7. **Who wrote it** — proposals are labelled as job-generated.
