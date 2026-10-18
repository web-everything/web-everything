---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/dispatch-contracts.mjs", "we:scripts/lib/provider-routing.mjs", "we:scripts/lib/__tests__/dispatch-contracts.test.mjs", "we:scripts/lib/__tests__/provider-routing.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Check roster membership generically in probationWorkerForRoute (or in decideDispatchRoute): rejec… (from web-everything/web-everything#5370 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/dispatch-contracts.mjs:1405` — Check roster membership generically in probationWorkerForRoute (or in decideDispatchRoute): reject any derived worker id that is not in PROBATION_ROSTER[taskType]. Add an invariant test over every roster task type and every catalogue model.
2. `we:scripts/lib/provider-routing.mjs:70` — Add a lint or standards rule banning settings reads at module top level (cascade or readSettings calls outside functions). Add a test that flips settings between two routing calls and asserts the second call honours the change.
3. `we:scripts/lib/dispatch-contracts.mjs:1405` — Put the enabled/model authorization check inside probationWorkerForRoute itself, so every hand-off shares one chokepoint. Add an invariant test that every route-to-worker path returns null or refuses when the worker's feature switch is off.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5370@e0365f18a762ce3291abb01bd9e6f06e63ff13f1

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
