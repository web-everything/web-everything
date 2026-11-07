---
bornAs: xvo1p1m
kind: story
size: 2
status: open
scope: ["we:scripts/gemini-direct-task.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# gemini-direct-task hangs after an agy error_message step

MED priority hint. ## (held 2026-10-25 20:51 ET) gemini-direct-task hangs after an agy error_message step A 4075-sort batch: agy (gemini-4-argon-high, --review) ran 592s, hit about 32.4k thinking/output tokens, ended with an `error_message` step and no final answer. we:scripts/gemini-direct-task.mjs then hung with empty output until stopped. Fix: treat an error_message terminal step (or agy exit without a final answer) as a failure, exit non-zero with the message, and never hang. Related: card #4678 (agy provenance/quota).

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
