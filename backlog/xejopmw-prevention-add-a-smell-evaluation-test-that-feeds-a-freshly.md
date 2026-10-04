---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/review-set-label.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs", "we:scripts/__tests__/review-set-label.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Add a smell-evaluation test that feeds a freshly opened draft with no labels through runHealthTic… (from web-everything/web-everything#3767 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-core.mjs:1355` — Add a smell-evaluation test that feeds a freshly opened draft with no labels through `runHealthTick` and asserts no episode opens. A lens question ('does this alert fire on a normal lifecycle state?') would also catch it.
2. `we:scripts/review-set-label.mjs:1367` — Add a test that runs the missing-mode CLI into a refused pre-write read and asserts `countRearmComments` is unchanged. Alternatively, use a distinct marker for missing-family restores so they are not counted.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3767@4c0ec48c7faca02cab8a92dc845bb34018923d5e

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
