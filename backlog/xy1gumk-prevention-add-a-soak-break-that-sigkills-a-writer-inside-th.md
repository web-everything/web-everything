---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/lane-lease-lock.mjs", "we:scripts/lib/lane-lease-heartbeat.mjs", "we:scripts/lib/__tests__/lane-lease-lock.test.mjs", "we:scripts/lib/__tests__/lane-lease-heartbeat.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add a soak break that SIGKILLs a writer inside the critical section and asserts that the next lan… (from web-everything/web-everything#7488 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/lane-lease-lock.mjs:23` — Add a soak break that SIGKILLs a writer inside the critical section and asserts that the next lane-pool command either recovers automatically or names the exact recovery step. Alternatively add a lint that requires every new filesystem mutex to have a dead-owner reaper.
2. `we:scripts/lib/lane-lease-heartbeat.mjs:109` — Add a parameterized deterministic test covering positive TTLs below three seconds and asserting the scheduled interval is at most TTL/3.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7488@852fdf7c2c52c9563d28594fdc2c2dd7d851989f

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
