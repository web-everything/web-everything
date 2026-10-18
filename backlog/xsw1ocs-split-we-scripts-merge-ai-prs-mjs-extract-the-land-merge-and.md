---
kind: story
size: 5
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/drain-land-path.mjs", "we:scripts/__tests__/merge-ai-prs-split-land.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Split we:scripts/merge-ai-prs.mjs: extract the land, merge and report paths into modules (part 2 of 2)

Part 2 of 2 of the split of we:scripts/merge-ai-prs.mjs (part 1 moves queue selection and hold decisions). Move the land, merge and pass-report code into modules under we:scripts/lib/ with no behavior change, so the entry file is only wiring. Goal: two drain fixes touching different concerns stop colliding on one file. Related older card: 2784. [A1] Executable: node --test we:scripts/__tests__/merge-ai-prs-split-land.test.mjs passes and the full drain test set passes unchanged. Priority: top (operator 2026-10-17).

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
