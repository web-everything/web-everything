---
bornAs: x0p42cq
kind: story
size: 3
status: open
scope: ["we:scripts/lib/merge-queue-adaptive-batching.mjs", "we:scripts/lib/drain-merge-strategy.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# merge-queue batching admission fails open on queue-read error

we:scripts/lib/merge-queue-adaptive-batching.mjs admit() returns admit:true when the queue read or state processing errors, so class separation (cards vs code) and the global maxGroupsInFlight cap are bypassed, and we:scripts/lib/drain-merge-strategy.mjs keeps enqueueing after a thrown admission error. Pre-existing; surfaced by the codex audit of the cards-class PR (R941b). Make it fail closed with a retry reason.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/merge-queue-adaptive-batching.test.mjs` with a new test: a queue-read error makes admit() refuse (admit:false, retry reason) and the drain does not enqueue.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change class grouping or the cap values.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no free text consumed.
2. **Truncated reads** — a partial queue read counts as an error: refuse and retry.
3. **Shared state files** — n/a: no new state file.
4. **Fail closed** — this item's whole point: any read or processing error refuses admission.
5. **Identity scoping** — n/a: groups already keyed per repo.
6. **State over time** — a refused PR is retried by the next catch-up round.
7. **Who wrote it** — n/a: no authored markers read.
