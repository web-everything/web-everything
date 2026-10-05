---
bornAs: xb8x2qq
kind: story
size: 3
status: open
scope: ["we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Merge re-check must never guess the tested main commit from timestamps

Finding from PR #3794 (CONFIRMED): the timestamp fallback in we:backlog/5117 can treat an untested main commit as tested. Failure scenario: a back-dated commit lands on main after a CI run started; its timestamp precedes the run, so it is taken as tested, and both merge protections (re-check and main-red halt) are bypassed. Hardens 5117. Done when: (1) the tested main SHA is read exactly from a source pinned to the run, else unknown, and unknown counts as moved with no exemption; (2) no timestamp fallback constant is exported; (3) a back-dated-commit fixture test fails before the fix and passes after.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
