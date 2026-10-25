---
bornAs: xptu78v
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/review-red-team-on-skip.mjs", "we:backlog/x46te7z-coverage-exercise-pending-skip-quarantine-removal-fallback.md", "we:backlog/xebglin-prevention-validate-regression-mapping-test-titles-in-standa.md", "we:scripts/lib/__tests__/review-red-team-on-skip.test.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — Add a lifecycle test table that runs runReviewJob with every persisted prior-status shape (ran, r… (from web-everything/web-everything#5890 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:scripts/lib/review-red-team-on-skip.mjs:14` — Add a lifecycle test table that runs runReviewJob with every persisted prior-status shape (ran, resumed, object forms) followed by an erroring retry, and asserts the status written afterwards. Prefer a shared fixture over per-shape ad hoc tests.
2. `we:backlog/x46te7z-coverage-exercise-pending-skip-quarantine-removal-fallback.md:16` — Require acceptance entries to cite repository-qualified files and explicit planned test titles; validate title existence when implementation completes. The quarantine coverage work is already filed in this card.
3. `we:backlog/xebglin-prevention-validate-regression-mapping-test-titles-in-standa.md:15` — Add named planned cases in a concrete we:scripts/__tests__/ test file for each Acceptance constraint, and enforce Acceptance-to-test mappings through a deterministic standards rule; the supplied card records the intended validator but shows no existing enforcement.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 3 → #5473, finding 4 → #5473.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5890@725c047ffbc7ebdd70a36e671fe30545a46451f0

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
