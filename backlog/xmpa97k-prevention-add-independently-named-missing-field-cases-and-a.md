---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs", "we:scripts/lib/__tests__/drain-merge-strategy.test.mjs", "we:scripts/conveyor/soak/breaks/fix-push-hold-pending-eligible-route.mjs", "we:scripts/conveyor/soak/breaks/__tests__/fix-push-hold-pending-eligible-route.test.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Prevention — Add independently named missing-field cases and a deterministic mutation gate covering undefined-… (from web-everything/web-everything#7534 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs:3096` — Add independently named missing-field cases and a deterministic mutation gate covering undefined-value acceptance for each field.
2. `we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs:3073` — Assert the resume and dispatch spy outcomes, and gate removal of the resume invocation with a targeted mutation test.
3. `we:scripts/lib/__tests__/drain-merge-strategy.test.mjs:162` — Use isolated guard fixtures and a deterministic mutation gate that bypasses current-head red-team enforcement while requiring its named test to fail.
4. `we:scripts/conveyor/soak/breaks/fix-push-hold-pending-eligible-route.mjs:50` — Look cases up by name, or export named index constants, rather than hardcoding positions. A unit test asserting fixPresent is true when only the E3 case launches would also catch it.
5. `we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs:3096` — Add a deterministic missing-field test matrix that removes each required live field independently from an otherwise eligible E3 fixture.
6. `we:scripts/lib/__tests__/drain-merge-strategy.test.mjs:161` — Add a deterministic isolated-gate regression test with otherwise eligible labels and only old-head red-team evidence, asserting deferred admission and no enqueue request.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7534@72bffe7e7be874576eab0baf830989c6bca89fcb

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
