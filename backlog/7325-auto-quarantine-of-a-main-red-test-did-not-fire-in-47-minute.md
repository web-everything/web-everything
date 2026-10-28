---
bornAs: x2tertj
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/pr-watch.mjs", "we:scripts/conveyor/infra-blocked.mjs"]
dateOpened: "2026-10-28"
tags: []
---

# Auto-quarantine of a main-red test did not fire in 47 minutes

2026-10-28 10:15 ET. Auto-quarantine (#6014, R164) did not quarantine the main-red soak test in 47 min; quarantined by hand. Check whether only 1 main CI run happened (needs 2 failures?) or health-watch runs frozen code. Runbook should say a test-hermeticity regression with a test-only fix PR is quarantinable (the red-main worker declined). Related: #4999, #5699.

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
