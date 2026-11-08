---
bornAs: xvel34f
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/review-referral-hold.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# wake/hold release compares GitHub comment time with the local run start time

Flow-sim gap R4-G2, class K16 (mixed clock domains). Failing input: a parked or persistence-failed review run on head H, `last.startedAt` stamped from the local job host (we:review-referral-hold.mjs, startedAt from run.stepTimings 'read', :73-77). host clock skewed against GitHub server time (NTP drift, sleeping laptop resume, VM pause). Cited: we:scripts/conveyor/review-referral-hold.mjs:208. Soak-break sketch: local clock AHEAD -> an operator ruling or re-arm posted just after the run started looks older than the run, is never seen as a wake: stuck parked until another event/push. Local clock BEHIND -> comments written before the run look newer: spurious 'wake', an…

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
