---
bornAs: x2kaa36
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/fix-scope-policy.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs", "we:scripts/conveyor/__tests__/fix-scope-policy.test.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Add a multi-shared-file case with mixed failed-closed and conflict results to the 'wait only for… (from web-everything/web-everything#5194 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:2511` — Add a multi-shared-file case with mixed failed-closed and conflict results to the 'wait only for a landing holder' suite. Make the observation pick prefer `conflict:true`.
2. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1862` — Inject `holderStateReader` into `runReconcileFixDispatch` the way `regionReader` is injected. Add one dispatch test with a fake reader that asserts an accepted PR with no claim holds an overlapping waiter.
3. `we:scripts/conveyor/fix-scope-policy.mjs` — Add a deterministic reader regression test with label pageInfo.hasNextPage=true; require pagination or an unreadable-state result before permitting admission.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5194@54f4c140f353ed33c9c5b70b4e8d71bcdc1732db

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
