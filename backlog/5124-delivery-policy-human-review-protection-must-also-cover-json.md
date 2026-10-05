---
bornAs: xujtw7n
kind: story
size: 3
status: open
scope: ["we:scripts/lib/gate-config.mjs", "we:scripts/lib/delivery-policy.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Delivery-policy human-review protection must also cover JSON files that supply policy values through pointers

Finding from PR #3794 (CONFIRMED): the human-review protection covers only the root policy file (we:backlog/5113), not JSON files that supply policy values through pointers. Failure scenario: an ordinary PR edits only a pointed-to JSON file, the root policy file is untouched, so no review:human is forced and the policy is weakened without human review. Hardens 5113. Done when: (1) any file a policy value is read from is policy-tier and forces review:human when edited alone; (2) a test edits a pointer-target file alone with the root untouched and fails before the fix, passes after; (3) a pointer target that is not a registered policy-tier path is refused.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
