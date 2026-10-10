---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/xh8442i-drain-no-merge-while-a-fix-or-ci-heal-claim-is-live.md", "we:backlog/x3a69zv-ci-overflow-skip-the-local-gate-when-it-would-not-save-time.md", "we:backlog/xs4ewgh-per-item-task-core-exclusion-timeout-outcomes-effect-declara.md", "we:backlog/xt3sgtl-worker-launch-and-claim-lifecycle-hand-off-before-spawn-watc.md", "we:backlog/xug05a8-temporary-policy-overrides-carry-their-own-end-condition.md", "we:backlog/xh5sg8r-prepare-runs-an-earned-design-review-and-every-design-keeps.md"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — A checklist or review bot that cross-references each stated edge case constraint against the list… (from web-everything/web-everything#4810 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/xh8442i-drain-no-merge-while-a-fix-or-ci-heal-claim-is-live.md` — A checklist or review bot that cross-references each stated edge case constraint against the listed acceptance tests.
2. `we:backlog/x3a69zv-ci-overflow-skip-the-local-gate-when-it-would-not-save-time.md` — A PR template requiring every stated edge case to map to an explicit test case in the plan.
3. `we:backlog/xs4ewgh-per-item-task-core-exclusion-timeout-outcomes-effect-declara.md` — A validation rule requiring each numbered edge case class to have a corresponding linked test in the acceptance criteria.
4. `we:backlog/xt3sgtl-worker-launch-and-claim-lifecycle-hand-off-before-spawn-watc.md` — A check that cross-references each stated edge case constraint against the listed acceptance tests.
5. `(cited file withheld: not a plain path)` — Update the mandate to recognize 'Edge cases' and 'Acceptance' as aliases, or update the backlog template to match the mandate.
6. `we:backlog/xug05a8-temporary-policy-overrides-carry-their-own-end-condition.md:16` — A strict LLM pass that cross-references every enumerated feature in the description with the test plan.
7. `we:backlog/xh5sg8r-prepare-runs-an-earned-design-review-and-every-design-keeps.md:15` — A strict LLM pass that cross-references every enumerated behavioral constraint in the description with the test plan.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 1 → #5739.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4810@c97a1d3462a5f7cb224906fe7b0a5622e9e22d97

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
