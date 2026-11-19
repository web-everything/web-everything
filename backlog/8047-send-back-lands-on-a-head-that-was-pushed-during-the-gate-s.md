---
bornAs: xmmmc8w
kind: story
size: 2
status: open
scope: ["we:scripts/operations/red-team-gate-apply.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Send-back lands on a head that was pushed during the gate's send-back write

Flow-sim gap B-C6, class K6 (check-then-act race with no pin). Failing input: Result and confirmed `broken` finding for head A; labels review:accepted; gate run in progress. author pushes head B after the head re-read (we:red-team-gate-apply.mjs:195) and before review-set-label --to=changes finishes (spawn timeout 180 s, :274). Cited: we:scripts/operations/red-team-gate-apply.mjs:195-197. Soak-break sketch: wrong-clear/wrong-act: the new head B is bounced to review:changes with head A's findings; fixer is dispatched on stale text; B is never judged first

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
