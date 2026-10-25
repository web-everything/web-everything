---
bornAs: xtph5c6
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/build-dispatch-failures.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5472 (head 4a3207d31)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5472 (reviewed head `4a3207d3142511079f14ffb51b2ed6f6a5864fdd`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/build-dispatch-failures.mjs:96` — (edge-case, degraded) An intervening orphan failure erases the same-base unconfirmed counter
   - Scenario: On unchanged checkout base A: record an unconfirmed launch with base A; after its backoff, launch a worker that subsequently dies and is released by orphan adoption; then retry and record another unconfirmed launch with base A. Orphan adoption calls recordBuildFailure without base, overwriting the record with base:null and unconfirmedLaunches:0. Executing these three calls against the actual ledger module with filesystem writes redirected into memory produced unconfirmed counts 1,0,1. With default settings, the third failure receives ordinary 20-minute backoff, without the promised 120-minute
   - Claude's re-check: demonstrated break

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
