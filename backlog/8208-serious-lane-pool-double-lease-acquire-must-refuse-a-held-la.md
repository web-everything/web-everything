---
bornAs: xn19hdo
kind: story
size: 3
status: open
scope: ["we:scripts/lane-pool.mjs we:scripts/verify-lane.mjs"]
dateOpened: "2026-11-13"
tags: []
---

# SERIOUS: lane-pool double lease; acquire must refuse a held lane atomically, verify-lane must refuse a wrong holder branch

SERIOUS (2026-11-12 20:32 ET). lane-47 was handed to a second worker while held, and acquire printed no lease line. Acquire must refuse a held lane atomically; verify-lane must refuse when the lane head is not the holder branch. Code: we:scripts/lane-pool.mjs, we:scripts/verify-lane.mjs

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

## Duplicate admission

capability-search found no matching open card
