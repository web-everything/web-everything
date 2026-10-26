---
bornAs: xl4gbjq
kind: story
size: 2
status: open
scope: ["we:scripts/operations/record-red-team-ruling-io.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5923 (head cd1c3041b)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5923 (reviewed head `cd1c3041b01d662ed9c3a5e7c6135bc89074b709`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/record-red-team-ruling-io.mjs:389` — (failing-input, degraded) A failed reason post leaves an incomplete block that retries refuse
   - Scenario: Start with a confirmed break at round-cap and review:changes already present. Invoke --ruling=block; let the first POST persist operator-block, then make the second POST fail with HTTP 503. The operator's reason is absent, and execution never reaches the ledger append. Replanning the identical command refuses with 'no confirmed red-team break ... left to rule 'block'' because the persisted block and existing label are treated as completion. This was reproduced with injected IO. The partial operation should remain retryable until its reason and required recording steps complete.
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
