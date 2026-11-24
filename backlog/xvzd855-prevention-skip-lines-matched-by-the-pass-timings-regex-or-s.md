---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/enqueue-on-event.mjs", "we:scripts/lib/__tests__/enqueue-on-event.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Skip lines matched by the pass-timings regex (or select the first line matching an error shape) b… (from web-everything/web-everything#7424 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/enqueue-on-event.mjs:774` — Skip lines matched by the pass-timings regex (or select the first line matching an error shape) before choosing the line. Add a tier-1 case with timings preceding the error.
2. `we:scripts/lib/__tests__/enqueue-on-event.test.mjs:2229` — Add a guard case where the secret matches no blacklist pattern and is only reachable via env. Where possible, make the env argument required, or have runChild call a single helper so the threading cannot drift.
3. `we:scripts/lib/__tests__/enqueue-on-event.test.mjs:470` — Assert the exact result: 'x'.repeat(200) + '...'.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7424@2c6b9d29b3004b882337185bb1b90d55038bc72c

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
