---
bornAs: xnpcayd
kind: task
status: open
scope: ["we:scripts/review-set-label.mjs"]
dateOpened: "2026-10-28"
tags: []
---

# review-set-label clear-human takes a head pin (--expect-head)

2026-10-28 09:34 ET. we:scripts/review-set-label.mjs --to=clear-human has no head pin, so #6027's delegated-clear-human pass refuses in 'on' mode by design. Add a head pin to the clear-human path (fits the #5982 rebuild S1: approval bound to head) before switching R130 live.

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
