---
bornAs: xts0udq
kind: story
size: 5
parent: "3383"
status: open
scope: ["we:docs/agent/platform-decisions.md", "we:scripts/check-standards-rules.mjs"]
dateOpened: "2026-10-03"
tags: []
---

# Split the platform decisions log into one file per ruling with a generated index

Operator ruling 2026-10-03. we:docs/agent/platform-decisions.md is 6,069 lines and every ruling PR appends to it, so ruling PRs collide constantly. Live that night: #3771 queued 2nd behind #3787 on this file. Split every anchor into its own file and generate the index page at build time, so appending a ruling never touches a shared file. Keep every existing anchor link working; update the statute tooling that reads the file (codifiedIn checks, we:scripts/check-standards-rules.mjs, the ratify close-out in we:.claude/skills/next-backlog-item/SKILL.md). Done when: adding two rulings in two branches merges with no conflict (scripted test); every old anchor link resolves; check:standards is green.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
