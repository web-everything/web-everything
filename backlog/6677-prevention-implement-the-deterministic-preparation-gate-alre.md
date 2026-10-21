---
bornAs: x7e15kt
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/6337-prevention-add-a-check-standards-rule-for-moved-acceptance-c.md", "we:backlog/6338-prevention-add-a-unit-test-that-runs-every-listprs-consumer.md", "we:backlog/6340-prevention-add-a-job-store-test-where-a-failed-night-is-foll.md", "we:backlog/6342-prevention-have-readtick-or-decidedispatchroute-force-the-cl.md"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — Implement the deterministic preparation gate already filed in #5360/#5473, requiring named positi… (from web-everything/web-everything#5637 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/6337-prevention-add-a-check-standards-rule-for-moved-acceptance-c.md:16` — Implement the deterministic preparation gate already filed in #5360/#5473, requiring named positive and negative cases for behavioral validation rules.
2. `we:backlog/6338-prevention-add-a-unit-test-that-runs-every-listprs-consumer.md:16` — Implement the preparation gate already filed in #5360/#5473, requiring each planned case to state observable expected outcomes as well as its name and file.
3. `we:backlog/6340-prevention-add-a-job-store-test-where-a-failed-night-is-foll.md:16` — Implement the deterministic per-obligation preparation gate already filed in #5360/#5473, including separate mappings for each bundled requirement.
4. `we:backlog/6342-prevention-have-readtick-or-decidedispatchroute-force-the-cl.md:16` — Implement the preparation gate already filed in #5360/#5473, requiring explicit input and observable-output mappings for parameterized behavioral obligations.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 1 → #5473, finding 2 → #5473, finding 6 → #5473, finding 8 → #5473, finding 9 → #5473.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5637@01952cb86c88ee91eda21c4d80ec27cb62c49b20

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
