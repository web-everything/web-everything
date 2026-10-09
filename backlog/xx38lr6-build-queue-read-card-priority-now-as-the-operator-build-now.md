---
kind: story
size: 1
status: open
blockedBy: ["4355"]
scope: ["we:scripts/lib/build-queue.mjs", "we:scripts/lib/__tests__/build-queue.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# build-queue: read card priority: now as the operator build-now override (P1)

Operator ruling 2026-10-09 (build now on Plateau requests): a request filed with Build now ON gets card frontmatter priority: now, which must class as P1 through the existing operator override. we:scripts/lib/delivery-priority.mjs maps override now to P1. The card adapter buildQueuePriorityFacts in we:scripts/lib/build-queue.mjs (added by PR #4649, card 4355) maps only high and low, and that file is held by #4649, so this mapping waits for it. Done: buildQueuePriorityFacts returns override now byOperator for priority: now, a test proves a now card ranks P1 under enforce, and live backlog build-queue --json shows the card at priorityClass P1.

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
