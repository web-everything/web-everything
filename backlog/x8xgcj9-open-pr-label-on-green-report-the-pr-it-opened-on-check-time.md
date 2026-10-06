---
kind: story
size: 1
status: open
scope: ["we:scripts/operations/open-pr.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# open-pr label-on-green: report the PR it opened on check-timeout

Goal: on a check-timeout, the open-pr label-on-green path prints 'The PR was NOT opened' even though it opened the PR (seen on #4056, #4051, #4052 on 2026-10-06). Report the PR it created and that only the label step is pending, truthfully. Done when: a test with an injected check-timeout after a successful open asserts the output names the PR number and says the label step is pending, never says NOT opened; the genuinely-not-opened path keeps its message. No prepared checklist: scope is we:scripts/operations/open-pr.mjs and its sibling open-pr files (find the message by grep). Source: held list item 79.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
