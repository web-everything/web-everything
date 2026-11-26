---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/verify-lane.mjs", "we:scripts/__tests__/verify-lane.test.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Prevention — In the guardReport: false case of the unreadable-inventory test, assert the exact inventory-unava… (from web-everything/web-everything#7546 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/verify-lane.mjs:1318` — In the `guardReport: false` case of the unreadable-inventory test, assert the exact `inventory-unavailable` substring, and also assert it is absent when the guard failed on its own. File a card if no gate requires every new stderr message to be asserted.
2. `we:scripts/verify-lane.mjs:1318` — When a diff adds a stderr message, have a test assert it. The cheapest durable guard is a review-lens checklist item. A deterministic gate is not practical for this.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7546@798b112a99ab24a03ef74c2392d7e106009b79a0

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
