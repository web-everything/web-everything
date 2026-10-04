---
bornAs: xoh76xw
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/main-red-recovery.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Add a deterministic parameterized test that sets and restores WE_PR_SCOPED_CHECKS and exercises a… (from web-everything/web-everything#3916 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/__tests__/main-red-recovery.test.mjs:905` — Add a deterministic parameterized test that sets and restores WE_PR_SCOPED_CHECKS and exercises all three consumers without explicitly passing prScopedChecks, covering a custom-only check and an empty-string override.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3916@05a4b8641fec547d4dbe5903e0f78bf1f20c9bfd

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
