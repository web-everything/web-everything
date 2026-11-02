---
bornAs: xr26ywt
kind: story
size: 2
status: open
scope: ["we:land-prevention-card.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# the review daemon's prevention-card pending spool holds 619 entries that never drain — every land-prevention-c

HIGH priority hint. - (2026-10-31 21:08 ET) HIGH: the review daemon's prevention-card pending spool holds 619 entries that never drain — every land-prevention-card run re-tries all 619 (was 619 git fetches/run before #6146; now cheap but still wasted). Find why they keep failing (admission refusal? stale/duplicate entries?), drain or retire them, and make the spool cap/expire stuck entries. Evidence: #6146 worker, drainPendingPrevention (we:land-prevention-card.mjs ~398).

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
