---
bornAs: xls5pjc
kind: story
size: 2
status: open
scope: ["we:scripts/operations/review-extra-seats.mjs"]
dateOpened: "2026-11-13"
tags: []
---

# we:review-extra-seats.mjs:2084 The parent job's final write can undo finish-time sealing and supersede success with an un (web-everything#6535)

1. `we:scripts/operations/review-extra-seats.mjs:2084` — The parent job's final write can undo finish-time sealing and supersede success with an unfinished check.

Operator card follow-up for web-everything/web-everything#6535 (head e06d825c0596d5e5cc7c016d53bc051e110d3ff6).

Not worse than main (R903): Only the opt-in check-run cutover path is affected; default redTeamGate.source=both keeps the legacy drain-scan hold, so main's guard still holds (R903).

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
