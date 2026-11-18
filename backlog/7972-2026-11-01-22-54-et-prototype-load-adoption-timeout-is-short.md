---
bornAs: xycpzvt
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# (2026-11-01 22:54 ET) prototype-load adoption-timeout is shorter than busy-pool smoke (~10 min) + a long daemo

MED priority hint. - [ ] (2026-11-01 22:54 ET) prototype-load adoption-timeout is shorter than busy-pool smoke (~10 min) + a long daemon pass → false "LOAD FAIL" every busy evening (drain #6224, review, fix). Size the wait from the daemon pass time or return registered-pending (cf. #6182, whose audit flagged ok:true-on-timeout as weakening — must stay ok:false + explicit pending state).

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
