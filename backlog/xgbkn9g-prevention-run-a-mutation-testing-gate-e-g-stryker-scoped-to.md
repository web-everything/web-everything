---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/resource-pool-io.test.mjs", "we:scripts/lib/resource-pool-io.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — Run a mutation-testing gate (e.g. Stryker scoped to changed lines) over each exported function wh… (from web-everything/web-everything#7609 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/resource-pool-io.test.mjs:584` — Run a mutation-testing gate (e.g. Stryker scoped to changed lines) over each exported function whose doc states a guarantee. Cheaper option: a review-lens checklist item that each 'stays distinct' or 'counts once' claim needs one case where only the discriminating field differs (repo first in fix, repo second in workers, expect 2 holders).
2. `we:scripts/lib/resource-pool-io.mjs:356` — Add a standards or lint rule (or a review-lens item) requiring each injectable default of an exported collector to be exercised by at least one test that omits the override, or that asserts the default's identity (e.g. legacy defaults to admit). Add one case that runs the real admit with an empty temp coord and expects legacyDecision 'unknown'.
3. `we:scripts/lib/__tests__/resource-pool-io.test.mjs:627` — Add a deterministic integration test that seeds the ledger at its configured byte cap, appends shadow rows, and asserts rotation and persistence of the new observations.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7609@809a20671b5022fd374e8142dd22f03fdc4dc8aa

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
