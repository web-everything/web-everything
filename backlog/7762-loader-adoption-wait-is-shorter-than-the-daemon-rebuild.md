---
bornAs: xd9tc8t
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# Loader adoption wait is shorter than the daemon rebuild

MED priority hint. ## (held 2026-10-25 16:41 ET) Loader adoption wait is shorter than the daemon rebuild Fix daemon 20:35Z: prototype-load reported adoption-timeout while the rebuild job (pid 10215) was still running at 10+ min, so the result looked like a failure. Fix: the loader should report "adoption-pending (rebuild job <id> running)", not FAIL, while a rebuild job for its sha is live. Derive the wait from the median rebuild time, or emit a later LOAD ok/FAIL event from the rebuild job itself when it ends. - 2026-10-25 16:56 ET: cases 3+4: #5925 (2 of 3 findings already ruled) and #5926 again at 20:55Z (the R105-carded finding was re-raised on the new head). Check first whether #5924 (port D, ruling-ledger re-check carry rules) already fixes this once it merges.

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
