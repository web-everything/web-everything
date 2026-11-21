---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/ci-heal-pr-dispatch.mjs", "we:scripts/conveyor/reconcile-core.mjs", "we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Filter on the per-request marker in confirmedTimeouts and in the follow-up gate, and add a mixed-… (from web-everything/web-everything#7280 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/ci-heal-pr-dispatch.mjs:896` — Filter on the per-request marker in `confirmedTimeouts` and in the follow-up gate, and add a mixed-origin state test. A shared state-schema helper that takes the request class as a parameter would make this a deterministic check.
2. `we:scripts/conveyor/reconcile-core.mjs:2903` — Add negative planner cases for a mismatched head or pr annotation and for a missing `review:pending` label. A mutation-testing pass over reconcile-core guards would catch this class.
3. `we:scripts/conveyor/reconcile-core.mjs:2905` — Add a planner-level negative-binding test. More generally, add a mutation-probe lint that fails when a newly added `if (a === b && ...)` guard has no test where each operand is perturbed.
4. `we:scripts/operations/ci-heal-pr-dispatch.mjs:1011` — Require each new early-return `refuse(...)` reason string to be asserted by at least one test, enforced by a check:standards rule that greps refusal reasons against test files.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7280@d3661f3c426961f834d54f2e862cfe7e061d6d18

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
