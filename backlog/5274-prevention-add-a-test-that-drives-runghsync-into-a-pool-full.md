---
bornAs: x7cd2m7
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/gh-throttle.mjs", "we:scripts/conveyor/health-smells/__tests__/daemon-silent.test.mjs", "we:scripts/lib/__tests__/gh-throttle.nested-slot.test.mjs", "we:scripts/lib/__tests__/gh-throttle.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add a test that drives runGhSync into a pool-full timeout and asserts the slot_timeout line. Long… (from web-everything/web-everything#4264 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/gh-throttle.mjs:1580` — Add a test that drives `runGhSync` into a pool-full timeout and asserts the `slot_timeout` line. Longer term, a lint that requires every call site of a new shared helper to be covered by a test.
2. `we:scripts/lib/gh-throttle.mjs:1749` — Have the outer write a per-invocation token, for example its slot file path or owner id. The passthrough would honour the skip only if that slot is live and owned by a live pid. Alternatively, strip the var from the env handed to the real gh child so descendants cannot inherit it. A test that spawns a grandchild with the var set would pin the behaviour either way.
3. `we:scripts/conveyor/health-smells/__tests__/daemon-silent.test.mjs:99` — Add deterministic cases where the configured floor determines the threshold and where it changes hung detection with a stale heartbeat.
4. `we:scripts/lib/__tests__/gh-throttle.nested-slot.test.mjs:41` — Add deterministic nested-call tests with exhausted points and write budgets, including a write operation, asserting no waiting or additional budget charge.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4264@d099cca551e9a94bfe12c3c0f7b818f884e3d339

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
