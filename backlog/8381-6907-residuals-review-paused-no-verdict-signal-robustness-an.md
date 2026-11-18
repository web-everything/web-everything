---
bornAs: xgqc5bb
kind: story
size: 1
status: open
scope: ["we:scripts/conveyor/pass-daemons/pr-merge-watch-signals.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# #6907 residuals: review-paused-no-verdict signal robustness and real-filter test

2026-11-15 18:04 ET (#6907 residuals, R825 reinforce-later): the review-paused-no-verdict signal skips malformed run records without failure(); the 24h run-age window may miss long pauses; the monitor-filter test compares two literals instead of the real filter.

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
