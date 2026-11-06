---
bornAs: xgfhjl3
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-rebuild/adopt.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# #6033 slice A PARKED for design

HIGH priority hint. - (HIGH, 11-02 13:36 ET) #6033 slice A PARKED for design: branch lane/6033-slice-a-registration-generations 88cdb3d1a7 (248 tests; :736 refresh fixed; CAS named tests). Open: (1) we:adopt.mjs:301 skips applied rows without registrationId → must HOLD; (2) we:adopt.mjs:302 check-then-reset is non-atomic vs registration writers using a different mutex → registration writes and adoption must share ONE lock (the clone write lock). This is the same concurrency class #6033 never converged on; design the single-lock contract first (ties to parked #22 single-owner rebuild). Slice D #6226 continues; C = design card.

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
