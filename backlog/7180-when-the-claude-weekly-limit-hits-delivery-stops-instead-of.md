---
bornAs: xtttorg
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# When the Claude weekly limit hits, delivery stops instead of moving to Codex

[held entry 362] (coroner 2026-10-16, held, HIGH — relates 64, 360) When the Claude weekly limit hits, delivery stops instead of moving to Codex. 10-15 22:07 ET to 10-16 16:17 ET (18 h): 2 merges in 14 h; fixers, ci-heal and review seats waited on Claude. Fix idea: the dispatch layer reads the provider quota state; when Claude is capped it routes fix, ci-heal and prepare to Codex (and the review security seat once card 360 lands) and says so in the run record. It returns to Claude when the reset time passes. Evidence: we:handoff-webeverything.md 10-16 16:40 ET; merge times from gh (gap 02:07Z to 20:17Z). Scope: we:scripts/conveyor fix-dispatch provider routing, we:review-seat-provider.mjs. Size 3.

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
