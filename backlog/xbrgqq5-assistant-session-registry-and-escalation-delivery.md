---
kind: story
size: 5
status: open
scope: ["we:scripts/operations/", "we:scripts/conveyor/"]
dateOpened: "2026-10-17"
tags: []
---

# Assistant session registry and escalation delivery

Make the operator session bootstrap write a durable registration (session id, account, host, capabilities, quiet policy, heartbeat), refreshed whenever sessions or accounts switch. Daemon escalations go to the needs-you feed plus a direct message to the live registered session, with evidence and a suggested pick. When no live session is registered (stale heartbeat), they fall back to a desktop or phone notification, or to the 07:00 digest during quiet hours. The session acknowledges each item in three steps: received, presented, decided. Operator 2026-10-17: "the assistant will move from handling to being on the receiver end".

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
