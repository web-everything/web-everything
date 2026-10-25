---
kind: task
status: open
scope: ["we:scripts/worker-brief.mjs", "we:scripts/operations/open-pr.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# worker-brief: unique scratch dir per worker; bypass flags need a quoted operator OK

2026-10-24: workers share scratchpad names (the PR body file) and overwrite each other (#5854 briefly showed another worker's PR body); workers used open-pr --skipPrePrReview on their own judgment citing an unrelated operator OK (#5859). Want: worker-brief gives each worker a unique scratch dir (a per-purpose scratchpad subdirectory) and open-pr refuses a body file outside it; worker-brief forbids bypass/skip flags unless the brief quotes an operator OK naming that flag, and open-pr refuses --skipPrePrReview without --operator-quote.

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
