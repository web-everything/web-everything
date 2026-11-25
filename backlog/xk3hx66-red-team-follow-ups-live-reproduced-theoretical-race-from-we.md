---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/daemon-host-gate.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Red-team follow-ups [live-reproduced, theoretical-race] from web-everything/web-everything#7503 (head 5f93828fb)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7503 (reviewed head `5f93828fb33a0e8cd266c29be154bb746f95bb39`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/daemon-host-gate.mjs:334` — (edge-case, degraded) A synchronous readiness validator can exceed the deadline and still promote green.
   - Scenario: Enable swap with greenCapable=true and readinessTimeoutMs=5. Start green through blue's reload IPC, then exit blue with code 77. Supply a candidateReady callback that performs synchronous work before returning true. In the probe, validation took 37 ms, yet green was promoted. The timeout is created only after candidateReady returns, so its execution time is excluded. The gate should measure elapsed time from before validation, refuse the overdue candidate, stop green, and retain exit code 77.
   - Class: live-reproduced (basis: Observed by executing the checked-out runGate implementation in Node with in-memory process and marker adapters and real synchronous work. This requires the explicitly enabled dependency-injected swap path; the current CLI does not supply the capability and readiness hooks.)
   - Also class: theoretical-race
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
