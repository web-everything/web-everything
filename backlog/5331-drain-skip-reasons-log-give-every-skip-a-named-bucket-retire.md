---
bornAs: x2dhhsl
kind: story
size: 1
status: open
scope: ["we:scripts/lib/drain-skip-reasons.mjs", "we:scripts/lib/__tests__/drain-skip-reasons.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Drain skip-reasons log: give every skip a named bucket, retire the 'other' bucket

Coroner 2026-10-07 F7: plateau-app #212 sat 86 passes as 'other' (no bucket recorded) because its couple partner WE #4288 was checks-pending. Name partner-pending, ready-not-reached, not-certified, off-base, codeql-failed, empty-body, stale-read, escalated, unrecognized-reason. Logging only, no merge-decision change.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
