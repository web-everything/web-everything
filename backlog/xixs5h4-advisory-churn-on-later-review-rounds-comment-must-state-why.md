---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/jury-core.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Advisory churn on later review rounds; comment must state why not accept

On #3794 every review round found new advisory findings (14 fix starts, 4 pushes). Consider limiting later-round advisory findings to code the last fix changed, or a round cap before the escalation ladder. Also: the advisory comment must lead with a one-line reason the verdict is not accept (e.g. Changes: security owes a prevention card), since the operator read it as accepted.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
