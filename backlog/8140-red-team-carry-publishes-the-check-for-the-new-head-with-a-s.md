---
bornAs: xsxze75
kind: story
size: 3
status: open
scope: ["we:scripts/lib/"]
dateOpened: "2026-11-09"
tags: []
---

# Red-team carry publishes the check for the new head, with a shared live-publish helper (R789 break 2)

Operator ruling R789 (2026-11-09 09:21 ET) sent red-team break 2 on #6535 to a follow-up PR: the R503 patch-id carry leaves the new head with no red-team check. Add publishRedTeamCheckFromLive to we:scripts/lib/red-team-check-run.mjs and call it from the carry in we:scripts/operations/review-job.mjs after the carry comment. Fail closed: on refusal or error post nothing and never throw. Design: operator handoff design note for the 6535 follow-ups, PR-A.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/operations/review-job-rebase-carry.test.mjs we:scripts/lib/red-team-check-run.test.mjs` passes: the carry publishes once for the new head after the comment; a blocked label, held break, in_progress run or missing result posts nothing; a race posts a superseding failure.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not retry a failed publish; a recovery sweep is a separate card (design residual). Does not change the ruling republish (PR-B).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: covered by the design (fail closed, liveness only; every decision re-derived from the gate readers).
2. **Truncated reads** — n/a: covered by the design (fail closed, liveness only; every decision re-derived from the gate readers).
3. **Shared state files** — n/a: covered by the design (fail closed, liveness only; every decision re-derived from the gate readers).
4. **Fail closed** — n/a: covered by the design (fail closed, liveness only; every decision re-derived from the gate readers).
5. **Identity scoping** — n/a: covered by the design (fail closed, liveness only; every decision re-derived from the gate readers).
6. **State over time** — n/a: covered by the design (fail closed, liveness only; every decision re-derived from the gate readers).
7. **Who wrote it** — n/a: covered by the design (fail closed, liveness only; every decision re-derived from the gate readers).
