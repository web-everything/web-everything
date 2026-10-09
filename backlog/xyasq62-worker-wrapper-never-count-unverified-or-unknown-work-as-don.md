---
kind: story
size: 5
status: open
scope: ["we:scripts/conveyor/await-verify-pass.mjs", "we:scripts/operations/worker-wrapper.mjs", "we:scripts/operations/__tests__/"]
dateOpened: "2026-10-09"
tags: []
---

# Worker wrapper: never count unverified or unknown work as done — GATE before WE_WORKER_WRAPPER can be turned on

Gated follow-up from #4462 (operator approved with gate 2026-10-09; wrapper stays OFF until this lands). (1) we:scripts/conveyor/await-verify-pass.mjs:666 listSessions swallows a failed claude agents listing and reads missing sessions as session-gone — fail closed (unknown, retry), never gone; (2) we:scripts/operations/worker-wrapper.mjs: verification-wait exhaustion must finalize as timed-out/blocked, never success; (3) we:scripts/operations/worker-wrapper.mjs:271: an await record already expired at child exit must still require verification. Replay fixtures for each; then a live trial with the wrapper on for one role.

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
