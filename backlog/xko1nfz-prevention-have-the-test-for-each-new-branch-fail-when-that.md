---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/pr-status-label.mjs", "we:scripts/conveyor/__tests__/pr-status-label-ready-green.test.mjs", "we:scripts/conveyor/__tests__/pr-status-label.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Have the test for each new branch fail when that branch is removed. A mutation or coverage check… (from web-everything/web-everything#7258 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/pr-status-label.mjs:160` — Have the test for each new branch fail when that branch is removed. A mutation or coverage check on derivePrStatusLabel branches would flag this unreachable line.
2. `we:scripts/conveyor/pr-status-label.mjs:78` — Add a table-driven test for requiredCiGreen covering the review-gate exclusion, context-state checks and an empty effective required set. Alternatively, require every branch of a new pure helper to appear in a test.
3. `we:scripts/conveyor/pr-status-label.mjs:84` — Add a test that names the headSha-absent case and records the accepted behaviour. Add a card to bind readiness to a rollup head sha supplied by the fetch layer.
4. `we:scripts/conveyor/__tests__/pr-status-label-ready-green.test.mjs:1` — Add a table-driven test for `requiredCiGreen` that covers each early-return and filter branch. Add a mutation-testing gate on `we:scripts/conveyor/pr-status-label.mjs` and file a card for it.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7258@322702c544034cb758c4b6fc415eeabbd06ed027

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
