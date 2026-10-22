---
bornAs: xm4ufel
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/merge-gate-check.mjs", "we:scripts/lib/__tests__/merge-gate-ci.test.mjs", "we:scripts/__tests__/merge-gate-check.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Add a pin-failure case to the new describe block. Longer term, make the test helpers require one… (from web-everything/web-everything#5499 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/merge-gate-check.mjs:180` — Add a pin-failure case to the new describe block. Longer term, make the test helpers require one case per early-exit branch of a gatherer.
2. `we:scripts/lib/__tests__/merge-gate-ci.test.mjs:402` — Add a table-driven test over `pinnedHeadOf` error shapes (fork, moved head, missing expected) for each non-labels authority. A broader guard would be a test-presence check that every `throw` branch inside `gatherPrFacts` is hit by some test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5499@44b92833a2b5c8cfa81ba82d59ebb7b5a5d98b79

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
