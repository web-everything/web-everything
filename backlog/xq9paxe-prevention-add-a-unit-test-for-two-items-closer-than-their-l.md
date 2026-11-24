---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:blocks/time-tracks/TimeTracks.ts", "we:blocks/time-tracks/TimeTracksElement.ts", "we:blocks/__tests__/unit/time-tracks/time-tracks.test.ts", "we:blocks/time-tracks/__tests__/TimeTracks.test.mjs", "we:blocks/time-tracks/__tests__/TimeTracksElement.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a unit test for two items closer than their label width in one lane and for an item at x=1, and add a… (from frontier-ui/frontierui#53 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:blocks/time-tracks/TimeTracks.ts:175` — Add a unit test for two items closer than their label width in one lane and for an item at x=1, and add a rendered visual check for the demo with dense items. Both are test-strength items, and the PR says the geometry-stubbed tests already have a follow-up card.
2. `we:blocks/time-tracks/TimeTracksElement.ts:79` — Add a test asserting that no unplaced slot exists when only whitespace remains, and filter whitespace-only text nodes in the check.
3. `we:blocks/__tests__/unit/time-tracks/time-tracks.test.ts` — Add the named multi-item navigation test to the unit-test gate, asserting document.activeElement after each arrow key.
4. `we:blocks/time-tracks/TimeTracksElement.ts:76` — Add a deterministic custom-element test with differing configured and authored labels, asserting that title and aria-label preserve the complete displayed text after placement.

Idempotency key (do not edit): approval-prevention-key:frontier-ui/frontierui#53@8c73c6e65fca0a8e08fcb8b85fbd68da2cfceb8e

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
