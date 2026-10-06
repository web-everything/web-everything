---
bornAs: xxlzys9
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/jury-core.mjs", "we:scripts/lib/__tests__/jury-core.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Add a table-driven test that runs the linked-block rule against every clearance path in referralR… (from web-everything/web-everything#4119 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/jury-core.mjs:2845` — Add a table-driven test that runs the linked-block rule against every clearance path in `referralRecordState` (exact operator, carried, superseded, seat-disabled) and asserts the intended outcome for each. File as a backlog item.
2. `we:scripts/lib/jury-core.mjs:2872` — Add a negative test that links a wording to a block ruled by a non-independent reviewer. A check:standards rule that flags JSDoc guarantees with no named test is a heavier alternative.
3. `we:scripts/lib/jury-core.mjs:646` — Add a deterministic regression test that persists an accepted link to a later referral and verifies a single identity and shared block, covering both referral orderings.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4119@d12f9196bc4bee8082678da193cba090b92d0905

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
