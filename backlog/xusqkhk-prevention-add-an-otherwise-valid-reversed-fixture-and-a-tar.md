---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/resource-gate.test.mjs", "we:scripts/lib/__tests__/host-load.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add an otherwise-valid reversed fixture and a targeted mutation gate requiring its named test to… (from web-everything/web-everything#7505 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/resource-gate.test.mjs:354` — Add an otherwise-valid reversed fixture and a targeted mutation gate requiring its named test to fail when the ordering check is removed.
2. `we:scripts/lib/__tests__/host-load.test.mjs:354` — Add deterministic unequal-floor cases with available memory between the floors, and mutation checks replacing Math.max with either operand.
3. `we:scripts/lib/__tests__/resource-gate.test.mjs:353` — Add an isolated reversed-window regression test and a targeted mutation gate that removes the timestamp-ordering condition.
4. `we:scripts/lib/__tests__/host-load.test.mjs` — Add asymmetric floor cases and a targeted mutation gate replacing Math.max with each operand independently.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7505@cd56cf8848ea8463492dfdcef47049732a3cc719

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
