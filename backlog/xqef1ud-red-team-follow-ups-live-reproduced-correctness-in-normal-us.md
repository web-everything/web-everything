---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/urgent-verify.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7560 (head 4732b3e43)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7560 (reviewed head `4732b3e435f4e95f04ad9b023539007259908c1c`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/urgent-verify.mjs:208` — (failing-input, degraded) Branch fallback rejects the existing append-only fix-ready ledger
   - Scenario: The configured live ledger is already 1,550,581 bytes. Request SHA ba859ec2ad9e7d5d794c84af3a3d13b9d5c4fd75, recorded as lane/forge-retire-s1-mesa2, with the object absent and raw-SHA fetch refused. The verifier throws fix-ready-ledger-too-large before attempting the recorded branch. The writer deliberately retains append-only history, so ordinary ledger growth disables every branch fallback. A valid matching record should remain usable through bounded reading, as the existing adoption reader handles this ledger using its tail.
   - Class: live-reproduced (basis: A read-only replay executed the production isolate function against the actual configured ledger and observed this error with no branch fetch or checkout attempted. Git responses were injected to simulate missing-object and raw-SHA-refusal conditions; filesystem writes were suppressed. No network failure was asserted.)
   - Also class: correctness-in-normal-use
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
