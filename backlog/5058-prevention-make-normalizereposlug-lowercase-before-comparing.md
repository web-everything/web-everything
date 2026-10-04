---
bornAs: x8dqd9a
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/poc-land.mjs", "we:scripts/lib/__tests__/poc-branches-repo.test.mjs", "we:scripts/operations/__tests__/poc-land.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Make normalizeRepoSlug lowercase before comparing, and add a unit case in we:scripts/lib/__tests_… (from web-everything/web-everything#3917 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/poc-land.mjs:293` — Make normalizeRepoSlug lowercase before comparing, and add a unit case in we:scripts/lib/__tests__/poc-branches-repo.test.mjs for a mixed-case repoKey on both a WE and a sibling entry.
2. `we:scripts/lib/__tests__/poc-branches-repo.test.mjs:38` — Use a sibling entry with autoSync: true in this test and assert that it appears in neither sync calls nor returned results; retain the test as a deterministic regression gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3917@8589945f129e73e8f7d2709a342b5780a784eb6b

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
