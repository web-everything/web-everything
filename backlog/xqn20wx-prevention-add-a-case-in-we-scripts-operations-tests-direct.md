---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/operations/dispatch-lane-io.mjs", "we:scripts/operations/worker-wrapper-launch.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs", "we:scripts/operations/__tests__/dispatch-lane-io.test.mjs", "we:scripts/operations/__tests__/worker-wrapper-launch.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add a case in we:scripts/operations/__tests__/direct-exec-launch-routing.test.mjs: dispatchFix wi… (from web-everything/web-everything#7468 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1731` — Add a case in we:scripts/operations/__tests__/direct-exec-launch-routing.test.mjs: dispatchFix with executorDecision {executor:'claude', policyRoute:{provider:'codex'}} and the real wrapper must throw route-mismatch without calling launch. Require one behavioural refusal case per site listed in the tripwire's SITES.
2. `we:scripts/operations/dispatch-lane-io.mjs:2026` — Under DIRECT-EXEC-GUARD-HARDEN, add a contract test that runs every wrapped site against an override of codex primary with claude fallback and asserts the intended outcome. Have buildAgentArgv and the guard share one resolved route.
3. `we:scripts/operations/worker-wrapper-launch.mjs:145` — Update the comment to say the launcher returns but dispatch sites throw, and keep a dispatch-level sentinel test that names which behaviour is intended.
4. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1731` — Inject resolveRoute into dispatchFix, as the other two sites do, or decide that an explicit executor overrides policy and record that. Add a we:direct-exec-launch-routing.test.mjs case: policy `fix` is codex, the decision has no policyRoute, and the detached launch is not called (or the override is asserted).
5. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1731` — Add a behavioural case to we:direct-exec-launch-routing.test.mjs: dispatchFix with executorDecision {executor:'claude', policyRoute:{provider:'codex'}} (and 'agy-claude') through the real wrapper throws route-mismatch, never calls the detached launch, and releases the claim. Require one such refusal case per dispatch site.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7468@306f4da702bf89e848101df2ce61f79707273cce

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
