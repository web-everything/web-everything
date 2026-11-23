---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/pr-status-label-ready-green.test.mjs", "we:scripts/conveyor/pr-status-label.mjs", "we:scripts/conveyor/__tests__/pr-status-label.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Add requiredChecks: [] to the 'unknown required-check list' test. A table-driven case over [null,… (from web-everything/web-everything#7258 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/__tests__/pr-status-label-ready-green.test.mjs:27` — Add `requiredChecks: []` to the 'unknown required-check list' test. A table-driven case over [null, [], [,'x'], ['']\] would pin every disjunct of the guard.
2. `we:scripts/conveyor/pr-status-label.mjs:78` — Add a check or unit rule that readiness derivations must compare `pr.rowsHead` with `headRefOid`. Add a test with stale `rowsHead` and a green rollup that expects not ready-to-merge.
3. `we:scripts/conveyor/__tests__/pr-status-label-ready-green.test.mjs:1` — Add a tagReviewStatus-level test: accepted PR, pending required check, expects setLabels to remove status:ready-to-merge. Add an assertion that we:merge-ai-prs.mjs's go-ahead label logic does not import derivePrStatusLabel.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7258@d3ac2333f999c4a75704b9c2b2e6963af603ed3a

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
