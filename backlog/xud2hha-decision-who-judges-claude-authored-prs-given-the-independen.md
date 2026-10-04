---
kind: decision
status: open
dateOpened: "2026-10-03"
tags: []
---

# Decision: who judges Claude-authored PRs, given the independent judge must come from a different provider?

Ruling xne1udi (2026-10-03) lets an independent Opus judge clear review:human outside a protected list, but only from a different provider and actor than the PR author. Most PRs today are Claude-authored, so an Opus judge is refused on them and they stay human. Options: (A) keep Claude-authored PRs human; (B) seat a non-Anthropic strong model (for example Codex at high effort, via the existing codex judge port) for Claude-authored PRs; (C) read "different provider/actor" as "different actor" and let a fresh Opus session judge them. Epic xaojq81 ships A until this is ruled.

Not prepared yet: needs `/prepare` before the operator rules it.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
