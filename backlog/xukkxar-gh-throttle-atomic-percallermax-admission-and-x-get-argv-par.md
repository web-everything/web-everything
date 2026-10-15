---
kind: task
status: open
scope: ["we:scripts/lib/gh-throttle-holders.mjs", "we:scripts/lib/gh-argv.mjs", "we:scripts/lib/__tests__/"]
dateOpened: "2026-10-15"
tags: []
---

# gh-throttle: atomic perCallerMax admission and -X=GET argv parsing

Operator ruling 'card' on PR #5326 red-team breaks (2026-10-15 ~08:10 ET). (1) we:scripts/lib/gh-throttle-holders.mjs ~153: acquireGhHolderSlot checks capped() on a read-only snapshot and then trySlot without re-checking, so concurrent same-caller admissions can exceed perCallerMax; make the cap check atomic with the slot claim (re-check after claim, release on overshoot). (2) we:scripts/lib/gh-argv.mjs ~53: parseGhApiArgs reads -X=GET as method '=GET', so classifyGhWrite marks a GET as a write; parse the short-flag equals form. Tests for both.

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
