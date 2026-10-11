---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/main-ci-red-core.mjs", "we:scripts/conveyor/main-ci-red-io.mjs", "we:scripts/conveyor/__tests__/main-ci-red-core.test.mjs", "we:scripts/conveyor/__tests__/main-ci-red-io.test.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Prevention — Have checksOf return null when total_count is greater than check_runs.length (or paginate), and a… (from web-everything/web-everything#4947 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/main-ci-red-core.mjs:181` — Have checksOf return null when total_count is greater than check_runs.length (or paginate), and add a test in we:main-ci-red-tip.test.mjs for a truncated page.
2. `we:scripts/conveyor/main-ci-red-io.mjs:88` — Throw in `checksOf` when `page.total_count > page.check_runs.length`, or paginate. Add a unit test for the truncated-page case. A lint rule that flags `per_page=` GitHub list reads without a `total_count` guard would catch the whole class.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4947@ba82f66de6b4d1133d04a86c632d01cd024438ea

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
