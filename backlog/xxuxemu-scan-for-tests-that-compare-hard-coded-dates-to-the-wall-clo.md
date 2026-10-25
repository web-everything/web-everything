---
kind: task
status: open
scope: ["we:scripts/check-standards-rules.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Scan for tests that compare hard-coded dates to the wall clock and run a clock-shift job

coroner 2026-10-20: ledger-readiness-drain-facts used a fixture dated 10-13 against a 7-day ET window; at 00:00 ET it fell out and failed on plain main (fix #5736); merge-group CI failed from 04:39Z while push CI stayed green until 03:21Z, so red-main machinery idled and no merge landed 00:49 to 05:05 ET (255 min). Want: (a) check:standards flags fixtures with hard-coded dates compared to the wall clock without a pinned clock; (b) a nightly job runs the unit suite with the clock +8 days and files failures as cards.

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
