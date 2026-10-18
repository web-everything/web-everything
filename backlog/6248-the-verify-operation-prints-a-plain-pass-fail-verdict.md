---
bornAs: x28khww
kind: story
size: 2
status: open
scope: ["we:scripts/operations/verify.mjs", "we:scripts/operations/__tests__/verify.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# The verify operation prints a plain PASS/FAIL verdict

Live 2026-10-17: four worker drivers (#5505, #5506, #5507, #5510) reported "verify complete, 0 effects, no pass/fail line", so none could honestly say green. Fix: the verify operation's envelope and its last stdout line state PASS or FAIL plus the failing step; the default output carries it, not just --json. [A1] Executable: node --test we:scripts/operations/__tests__/verify.test.mjs asserts the last line is PASS or FAIL with the failing step on FAIL. Priority: top (operator 2026-10-17).

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
