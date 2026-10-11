---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs", "we:scripts/lib/resource-admission.mjs", "we:scripts/lib/resource-gate.mjs", "we:scripts/lib/__tests__/resource-gate.test.mjs", "we:skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon.test.mjs", "we:scripts/lib/__tests__/resource-admission.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — Add a runTickAllRepos test with fake fix and ci-heal results asserting the next pass's throttle s… (from web-everything/web-everything#4788 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs:742` — Add a runTickAllRepos test with fake fix and ci-heal results asserting the next pass's throttle sees the previous pass's queue length.
2. `we:scripts/lib/resource-admission.mjs:52` — A resource-admission unit test that injects a throwing repo-root resolver and asserts a platform-only policy is returned with an error entry.
3. `we:scripts/lib/resource-gate.mjs:139` — In shadow mode with the observer off, skip the extra admit() call. The legacy verdict decides, so no shared decision is needed.
4. `we:scripts/lib/__tests__/resource-gate.test.mjs:96` — Add a lint or checklist rule that every 'Must: on error …' line in a card's Acceptance maps to a named failing-input test. Failing that, add a review-lens item that checks error-path tests for loader functions that catch and continue.
5. `we:scripts/lib/resource-gate.mjs` — Add a deterministic throttle regression test with a stricter configured fix policy and an independently admissible ci-heal launch, asserting that the effective cap remains at the static floor.
6. `we:scripts/lib/__tests__/resource-gate.test.mjs` — Add deterministic loader tests for each unreadable layer, asserting that valid values from unrelated layers remain available and only the failed layer is reported.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4788@fd5b791d789c0a60ba5f3d960557049ff0aa8ee3

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
