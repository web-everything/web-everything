---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# #32 D-R379 check

HIGH priority hint. - (HIGH, 11-02 09:25 ET) #32 D-R379 check: side branch lane/d-r379-check-r381 8b09bc9fb2 (624 tests; pattern protection + whole-entry ruling match DONE). 2 new audit classes, both fail-closed one-liners: (1) hold labels (review:human etc.) applied then removed before ledger mirrors → read the issue timeline (labeled/unlabeled since head push); any hold seen → FAIL; (2) PR base != default branch → UNKNOWN (never diff vs origin/main for a non-main base). Then fast-forward #6247 and re-audit.

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
