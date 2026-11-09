---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/"]
dateOpened: "2026-11-09"
tags: []
---

# Recovery sweep backfills the red-team check for heads with a completed result and no published check (R789 break)

Red-team break on #6535 (confirmed, liveness only, ruled under R789 and R794): a head with a trusted completed red-team result comment but no published check run is held forever by we:scripts/merge-gate-check.mjs. Add a recovery sweep that calls the shared publish helper from the R789 follow-up design (operator handoff design note for the 6535 follow-ups, residual section) on such heads, with no new model round. Fail closed on any refusal.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/review-red-team-on-skip.test.mjs` passes: a head with a clean result comment and no check gets one success publish; a blocked label, in_progress run or head move posts nothing.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change merge-gate-check hold logic and does not start a new red-team round.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: covered by the design (fail closed, liveness only; every decision re-derived from the gate readers).
2. **Truncated reads** — n/a: covered by the design (fail closed, liveness only; every decision re-derived from the gate readers).
3. **Shared state files** — n/a: covered by the design (fail closed, liveness only; every decision re-derived from the gate readers).
4. **Fail closed** — n/a: covered by the design (fail closed, liveness only; every decision re-derived from the gate readers).
5. **Identity scoping** — n/a: covered by the design (fail closed, liveness only; every decision re-derived from the gate readers).
6. **State over time** — n/a: covered by the design (fail closed, liveness only; every decision re-derived from the gate readers).
7. **Who wrote it** — n/a: covered by the design (fail closed, liveness only; every decision re-derived from the gate readers).

## Duplicate admission

Distinct R789 liveness follow-up from the 6535 red-team sweep
