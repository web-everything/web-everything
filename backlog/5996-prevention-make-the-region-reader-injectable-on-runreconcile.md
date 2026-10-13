---
bornAs: xborz68
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/fix-scope-policy.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs", "we:scripts/conveyor/__tests__/fix-scope-policy.test.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Prevention — Make the region reader injectable on runReconcileFixDispatch. Add one test that passes a fake rea… (from web-everything/web-everything#5087 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1862` — Make the region reader injectable on `runReconcileFixDispatch`. Add one test that passes a fake reader and checks the closure's admit and block outcomes on a claim-held file.
2. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:2506` — Add a test that fixes the intended priority-versus-build-claim behaviour. If builds should hold, exempt `c.build` from the bypass.
3. `we:scripts/conveyor/fix-scope-policy.mjs:94` — Add a deterministic regression test with different merge bases and an intervening insertion; normalize ranges to a common revision or conservatively retain the file hold when their coordinate bases differ.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5087@7245287fd3f4e0a53fedea38f748d6cc78620610

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
