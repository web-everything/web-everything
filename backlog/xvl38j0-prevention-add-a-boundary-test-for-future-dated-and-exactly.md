---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add a boundary test for future-dated and exactly-at-window pendingSince. Optionally clamp with no… (from web-everything/web-everything#4315 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-core.mjs:2142` — Add a boundary test for future-dated and exactly-at-window pendingSince. Optionally clamp with `now - sinceMs >= 0`.
2. `we:scripts/conveyor/reconcile-core.mjs:2142` — Add a unit test for a future-dated or skewed `pendingSince`. Also add a clamp: require `sinceMs <= now`, and bound the env override to a finite value no larger than some maximum.
3. `we:scripts/conveyor/__tests__/reconcile-core.test.mjs:3440` — Add deterministic assertions immediately before and exactly at 30 minutes, with WE_TIMEOUT_RETRY_PENDING_ESCALATE_MS unset, plus a separate explicit-override case; run them in the existing test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4315@272633204558b8978ae83619009d36bbb3cda645

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
