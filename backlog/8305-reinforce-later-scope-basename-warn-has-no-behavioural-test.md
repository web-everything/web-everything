---
bornAs: xr5zq6t
kind: task
status: open
scope: ["we:scripts/check-standards.mjs"]
dateOpened: "2026-11-14"
tags: []
related: ["x2yhhtu"]
---

# Reinforce later: scope-basename WARN has no behavioural test and cannot fail on drift

The scope-basename count cap became a WARN (R907). Codex audit flagged residuals: the threshold test is source-text only, warn never fails CI, and a swallowed git ls-files failure yields zero findings. Add a behavioural test that runs the gate with a low threshold and asserts the warning line.

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

## Duplicate admission

follow-up residual of the scope-cap soften PR
