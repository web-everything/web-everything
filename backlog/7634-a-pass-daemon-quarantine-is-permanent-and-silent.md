---
bornAs: x195g32
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# A pass-daemon quarantine is permanent and silent

HIGH priority hint. - [HIGH] A pass-daemon quarantine is permanent and silent. The health-watch pass was quarantined from 10-28 11:54 ET, about 22 h with no ticks, after one watchdog overrun with an unconfirmed pgid. The owner pid is dead and the flag never clears; the only symptom was "failed 2 runs in a row". That hid #6051 and all freeze detection. Fix dispatched (purpose unblock-pass-quarantine, 10-29 10:46 ET). Coroner question: why did no event reach the orchestrator for 22 h?

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
