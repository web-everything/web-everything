---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/review-set-label.mjs", "we:scripts/conveyor/rearm-review.mjs", "we:scripts/conveyor/__tests__/no-code-rearm.test.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs", "we:scripts/__tests__/review-set-label.test.mjs", "we:scripts/conveyor/__tests__/rearm-review.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add a check:standards rule requiring every note kind pushed by planReconcile to be explicitly cla… (from web-everything/web-everything#7480 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-core.mjs:2928` — Add a check:standards rule requiring every note kind pushed by planReconcile to be explicitly classified (needs-decision, informational or status-only). Also assert that the post-success tick produces no needs-decision note.
2. `we:scripts/conveyor/reconcile-core.mjs:2414` — Add `expect(row).not.toHaveProperty('operatorAnswer')` for the incident tick-2 ci-heal row and the stale-ruling fix rows. As the class-level guard, use a review lens or mutation check that flags test normalizers which delete a field the diff changes without asserting it elsewhere.
3. `we:scripts/review-set-label.mjs:536` — Key the refusal on an explicit flag only the no-code executor passes, or teach the orphan planner to treat red-team labels. Add a contract test that runs each pinned re-arm caller (orphan guard, ci-heal, no-code executor) against each red-team label.
4. `we:scripts/conveyor/reconcile-core.mjs:2414` — Assert that every fix or ci-heal row planned after a no-code answer (stale, later verdict, later fix-begin) has no `operatorAnswer`. A mutation gate on changed guard lines would catch this class.
5. `we:scripts/conveyor/reconcile-core.mjs:1571` — Table test with one negative case per conjunct of `noCodeHandoff`, asserting the changes verdict remains in the findings. A mutation gate on suppression predicates would catch this class.
6. `we:scripts/conveyor/rearm-review.mjs:225` — Unit tests that call `rearmWindow().wouldHonour` and `buildOperatorAnswer` directly with a wrong head, wrong supersedes id and mismatched receipt head. A mutation gate on changed predicates would catch this class.
7. `we:scripts/conveyor/reconcile-core.mjs:2414` — Add a named regression asserting stale-ruling fixer rows omit operatorAnswer, and require it to fail when the exclusion predicate is removed.
8. `we:scripts/conveyor/__tests__/no-code-rearm.test.mjs:52` — Add a named two-tick replay test using captured incident fixtures with recorded provenance and assertions on both complete dispatch and refusal lists.
9. `we:scripts/conveyor/__tests__/no-code-rearm.test.mjs:51` — Add captured, sanitized incident fixtures and named two-tick replay tests asserting the complete dispatch and refusal arrays; require those tests in the acceptance gate.
10. `we:scripts/conveyor/reconcile-core.mjs:2414` — Add a deterministic payload-contract test that asserts operatorAnswer is absent for stale no-code rulings and retained for ordinary answers, and gate changes on that test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7480@24df93846f5b1abb3c5f897269af1e9fa138a2b1

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
