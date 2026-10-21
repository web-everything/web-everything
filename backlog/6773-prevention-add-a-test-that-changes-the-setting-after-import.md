---
bornAs: xqpib22
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/provider-routing.mjs", "we:scripts/lib/dispatch-routing-policy.mjs", "we:scripts/operations/probation-build-run.mjs", "we:scripts/lib/dispatch-contracts.mjs", "we:scripts/lib/__tests__/provider-routing.test.mjs", "we:scripts/lib/__tests__/dispatch-routing-policy.test.mjs", "we:scripts/operations/__tests__/probation-build-run.test.mjs", "we:scripts/lib/__tests__/dispatch-contracts.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Add a test that changes the setting after import and asserts the intended behaviour: either takes… (from web-everything/web-everything#5370 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/provider-routing.mjs:70` — Add a test that changes the setting after import and asserts the intended behaviour: either takes effect, or documented as restart-required. Longer term, read per dispatch tick instead of at import.
2. `we:scripts/lib/dispatch-routing-policy.mjs:98` — Assert `effort` in the gate-closed feature-route test, so any future drift is deliberate.
3. `we:scripts/operations/probation-build-run.mjs:242` — In parseArgs, `probationLaunchDecision` and `routeDispatch`, require `PROBATION_ROSTER[taskType]?.includes(worker.id)` for every task type, and add an invariant test over (worker, taskType) pairs.
4. `we:scripts/lib/dispatch-contracts.mjs:1362` — Add a deterministic boundary test covering null dispatch input and asserting a refusal without throwing; use optional access or validate before reading kind.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5370@c39543882e4c82ef7914efd1e9af97884fe2305a

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
