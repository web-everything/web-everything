---
bornAs: xi3s5g7
kind: story
size: 5
status: open
scope: ["we:scripts/lib/permission-change.mjs", "we:scripts/lib/review-escalation.mjs", "we:scripts/lib/review-core.mjs", "we:scripts/lib/review-policy.contract.json", "we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Permission-change hold: workflow permissions, sandbox grants and branch-protection config always get review:human

PR #4318 widened a workflow token to contents: write and merged on the automatic accept; #4359 widened a Codex sandbox. we:scripts/lib/review-escalation.mjs scoreEscalation and decideReviewGate now force review:human for any such diff via we:scripts/lib/permission-change.mjs, with a new human-clearance contract token in we:scripts/lib/review-policy.contract.json. Operator decision 2026-10-08.

## Done when

1. **Executable** - the suite we:scripts/lib/__tests__/permission-change.test.mjs fails on the old we:scripts/lib/review-escalation.mjs (the #4318 and #4359 replays are not human-required) and passes after.

Must: on a read error the diff section is unreadable, so a workflow file fails closed (any touch holds). Must: config, docs and data are treated cautiously too (CODEOWNERS, rulesets and required-checks files hold on any touch); only tests, docs and comment-only edits to code are exempt.

## Edge cases this change must handle

1. **Untrusted text** - n/a: the hold reads only changed diff lines with regexes and never executes or interpolates them.
2. **Truncated reads** - a workflow file with no readable hunks fails closed (holds).
3. **Shared state files** - n/a: pure functions, no state written.
4. **Fail closed** - unreadable workflow hunks hold; an accept without a head-bound human clearance re-parks review:human.
5. **Identity scoping** - n/a: path- and line-based, not identity-based.
6. **State over time** - the clearance must be bound to the live head sha, as the deviation hold already does.
7. **Who wrote it** - applies to every author, human or agent; it only ever adds a human park.
