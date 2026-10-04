---
bornAs: x75oa3a
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/promote-draft-pr-dispatch.mjs", "we:scripts/operations/__tests__/promote-draft-pr-dispatch.test.mjs"]
dateOpened: "2026-10-03"
tags: []
---

# Prevention — When adding a log or refusal producer, a test should run the full runTickAllRepos into onTick and asser… (from chalbert/web-everything#3816 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/promote-draft-pr-dispatch.mjs:187` — When adding a log or refusal producer, a test should run the full `runTickAllRepos` into `onTick` and assert one line per PR per cause. A dedupe assertion across the refusal and reconcile-refusal channels would catch this class of duplicate.
2. `we:scripts/operations/promote-draft-pr-dispatch.mjs:91` — Add a deterministic parameterized test covering null and incomplete closure objects, asserting that omitted code paths still count; removing the completeness guard should make the incomplete-object case fail.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3816@d43b4603a250f04c12007a2ce0cd25728144dbe7

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
