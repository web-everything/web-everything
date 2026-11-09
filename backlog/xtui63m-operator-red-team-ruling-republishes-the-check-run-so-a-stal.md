---
kind: story
size: 3
status: open
scope: ["we:scripts/operations/"]
dateOpened: "2026-11-09"
tags: []
---

# Operator red-team ruling republishes the check run so a stale failure clears (R789 break 3)

Operator ruling R789 (2026-11-09 09:21 ET) sent red-team break 3 on #6535 to a follow-up PR: an operator ruling leaves a stale failure check. Inject publishCheck into we:scripts/operations/record-red-team-ruling-io.mjs and call it after label resync in the clearing sinks only (card, not-real), never the block sink. Stacks on the PR-A card (shared helper). Design: operator handoff design note for the 6535 follow-ups, PR-B.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/operations/record-red-team-ruling-io.test.mjs` passes: a not-real ruling on the only break posts one success; a partial ruling, a syncLabels throw or a block ruling posts nothing; a failed publish exits non-zero and the failure stands.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not add the helper (PR-A card) and does not retry failed publishes.

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

Distinct: ruling-side republish in record-red-team-ruling-io; 7312 is a different card
