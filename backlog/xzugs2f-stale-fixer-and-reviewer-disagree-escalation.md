---
kind: task
status: open
scope: ["we:scripts/"]
dateOpened: "2026-10-05"
tags: []
---

# Stale fixer-and-reviewer-disagree escalation

On #3794 (2026-10-05) the ruling-dispute note (3 findings the operator ruled block came back... a person must decide) fired though the reviewer had already ruled all 3 not-real at 03:27 ET. The dispute check must read the live referral state on the current head, including reviewer rulings, before escalating. Related: #3964, #3967.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
