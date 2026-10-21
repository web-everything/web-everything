---
bornAs: xs9qg1k
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/review-status-tag.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5274 (head 2e02088b6)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5274 (reviewed head `2e02088b61a59c95891e0ae756881b35774c68ac`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/review-status-tag.mjs:307` — (edge-case, degraded) A successful merge-gate rerun still leaves the PR labeled ci-red because superseded failures reach the reducer.
   - Scenario: Required checks are [test, smoke, daemon-soak, soak-replay-gate, merge-gate]. All other checks succeed. The same-head rollup contains merge-gate FAILURE completed at 2026-10-14T12:00:00Z followed by merge-gate SUCCESS completed at 12:05:00Z. With review:pending, no live fixer, and a planned review, the tagger selects the latest SUCCESS for its excusal decision but passes both runs into derivePrStatusLabel. requiredCiRed scans every entry and returns true for the superseded failure, producing status:ci-red instead of status:awaiting-review. An accepted PR similarly receives ci-red instead of re
   - Claude's re-check: The tagger collapses the rollup only to read merge-gate's latest conclusion. It then passes the raw statusCheckRollup, with the superseded FAILURE still in it, to derivePrStatusLabel. requiredCiRed scans every entry with no collapse, so the old merge-gate FAILURE returns true and the label is ci-red even though the latest run succeeded.

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
