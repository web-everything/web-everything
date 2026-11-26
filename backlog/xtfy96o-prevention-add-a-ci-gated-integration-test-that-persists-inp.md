---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/ci-heal-pr-dispatch.mjs", "we:scripts/operations/fix-run.mjs", "we:scripts/lib/fix-slot-borrow.mjs", "we:scripts/operations/__tests__/fix-run.test.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs", "we:scripts/lib/__tests__/fix-slot-borrow.test.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Prevention — Add a CI-gated integration test that persists input-only outcomes, reaches the normal hold and bu… (from web-everything/web-everything#7532 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/ci-heal-pr-dispatch.mjs:670` — Add a CI-gated integration test that persists input-only outcomes, reaches the normal hold and build-change re-arm, and asserts strongerModel remains unset.
2. `we:scripts/operations/fix-run.mjs:725` — Add a CI-gated test spanning Claude settlement and the next dispatch pass, injecting a stand-down posting failure and asserting dispatch remains refused.
3. `we:scripts/lib/fix-slot-borrow.mjs:210` — Gate CI on paired cases showing that an absent cause permits dispatch while an explicit unknown cause refuses it.
4. `we:scripts/operations/__tests__/fix-run.test.mjs:2020` — Keep one table-driven test that forces cause 'model' on each error shape (status, signal, stderr, stdout, non-Error) and asserts the posted body excludes the raw text and secret values. A lint or standards rule could require that any `gh pr comment` path in we:scripts/operations/fix-run.mjs has a sanitisation test.
5. `we:scripts/operations/fix-run.mjs:735` — Record the unknown-cause marker in the provider-independent fix-loop ledger, or write it before the comment. Add a test parametrised over provider (codex and claude) that fails the comment post and asserts the next reconcile pass holds.
6. `we:scripts/lib/fix-slot-borrow.mjs:214` — Add a deterministic parameterized dispatch test contrasting omitted cause with explicit unknown and invalid causes; this guard needs a future backlog item.
7. `we:scripts/conveyor/reconcile-fix-dispatch.mjs` — Add a deterministic test with more than four distinct stood-down PRs that pins the read-call bound and retained refusals; this guard needs a future backlog item.
8. `we:scripts/operations/fix-run.mjs:756` — Add a deterministic integration regression feeding input-only outcomes into the loop ledger and exercising cooldown and build-change rearms, asserting that neither dispatch requests a stronger model.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7532@98ddfcd403d4c5719b7b370c143fa226495fd401

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
