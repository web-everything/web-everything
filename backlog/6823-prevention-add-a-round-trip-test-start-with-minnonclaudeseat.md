---
bornAs: xerg4pe
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/review-pr.mjs", "we:scripts/lib/review-seat-provider.mjs", "we:scripts/operations/__tests__/review-pr.test.mjs", "we:scripts/lib/__tests__/review-seat-provider.test.mjs"]
dateOpened: "2026-10-16"
tags: []
---

# Prevention — Add a round-trip test (start with minNonClaudeSeats=2, then resume via advanceReviewPrToWriteUp)… (from web-everything/web-everything#5441 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/review-pr.mjs:2374` — Add a round-trip test (start with minNonClaudeSeats=2, then resume via advanceReviewPrToWriteUp) and add a correctnessAdvisoryFromRun counterpart to codexAdvisoryFromRun. A deterministic guard would be a roster-equality assertion between the start and resume registrations for every settings combination.
2. `we:scripts/lib/review-seat-provider.mjs:143` — Make shadowSeatStatus return 'off (no policy)' when shadowPolicy is absent. Give the legacy fixtures an explicit enabled shadowPolicy. Add a unit test pinning that an absent policy never samples.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5441@454e87c072ee508452e5b63dec0957797d9bee1c

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
