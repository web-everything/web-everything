---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/cli-adapter.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#4865 (head f6d2033dd)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#4865 (reviewed head `f6d2033ddc3ce6e788277998028ffb441223f204`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/cli-adapter.mjs:1135` — (edge-case, degraded) A failed replacement judge loses later completed seats and their spend.
   - Scenario: Reproduced with an in-memory three-seat batch: A, B and C finish; B's request changes between planning and commitment, triggering the supported mismatch fallback; replacement B throws. The catch never calls saveRemainingSeats. The persisted record contains A and both B telemetry rows, but neither C's answer nor its $0.10 spend. Resume spawns C again. Persist the remaining completed seats and their telemetry before propagating the replacement failure.
   - Claude's re-check: In the mismatch fallback the diff replaces the old record-and-clear step with 'dropSaved(recordSeatSpend(current, pre), stepName)', so the other seats stay in 'prefilled'. The replacement judge's catch only records its own telemetry, and 'saveRemainingSeats' is not called there. The old code recorded every seat's spend and cleared 'prefilled' before the replacement ran. So if the replacement throws, C's answer and spend are lost, and a resume spawns C again. This is a regression.

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
