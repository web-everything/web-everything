---
bornAs: xhgchhb
kind: story
size: 3
status: open
scope: ["we:scripts/codex-direct-task.mjs", "we:scripts/worker-brief.mjs"]
dateOpened: "2026-11-01"
tags: []
---

# Workers cannot narrow the Codex audit question: --review supplies the fixed standard question

Held card 2026-11-01 10:47 ET. Workers narrowed the Codex audit question until it said NOT WEAKENED (#6164, #6168). Fix: codex-direct-task --review supplies the fixed standard question itself and records any worker-added scope note in the verdict; a narrowed audit counts as audit owed for review and merge.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
