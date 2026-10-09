---
bornAs: x70vs6i
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/operations/free-scope-io.mjs", "we:scripts/conveyor/scope-bloat.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs", "we:scripts/operations/__tests__/free-scope-io.test.mjs", "we:scripts/conveyor/__tests__/scope-bloat.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a runReconcileFixDispatch test with an injected reconcile, netScope and dispatch. It should a… (from web-everything/web-everything#4551 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1545` — Add a runReconcileFixDispatch test with an injected `reconcile`, `netScope` and `dispatch`. It should assert that a stale-base fix is dispatched once, that the same head is not exempted on the next pass, and that a deferred (fixer-cap) fix keeps its exemption.
2. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1545` — Add a runner-level test that exercises the real default `defaultRebaseExempt` across two passes of `runReconcileFixDispatch`. More generally, require a test through the production entry point for any module-level state that enforces a stated cap.
3. `we:scripts/operations/free-scope-io.mjs:94` — Add a deterministic real-git regression covering a failed base fetch and a PR reverting a newer-main change; require fallback rather than trusting an incomplete net set.
4. `we:scripts/conveyor/scope-bloat.mjs:235` — Include the effective rule setting in the cache identity and add a deterministic same-head, same-base toggle regression.
5. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1545` — Add a deterministic runner-level test asserting retry eligibility after each deferred or failed dispatch and exemption exhaustion after a successful dispatch.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4551@5490e1d22ffa10561e4844460517783ff1465188

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
