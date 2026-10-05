---
bornAs: xjj83hr
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/jury-core.mjs", "we:scripts/lib/__tests__/jury-core.test.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — A property test over the {carried backing valid | withdrawn} x {pending | dispatched} matrix that… (from web-everything/web-everything#3967 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/jury-core.mjs:2331` — A property test over the {carried backing valid | withdrawn} x {pending | dispatched} matrix that asserts every pending finding is either dispatchable or listed in rulingNeeded. Alternatively, have the carry sink re-validate existing carried entries against current operator rulings.
2. `we:scripts/lib/jury-core.mjs:2333` — Add a deterministic sink integration test that persists a carry, changes its backing operator ruling, reruns review, and asserts that the pending finding reaches the reviewer.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3967@ea22d84413db051a222b6aad22fddc69d35386d6

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
