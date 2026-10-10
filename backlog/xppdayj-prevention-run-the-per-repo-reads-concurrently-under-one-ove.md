---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/drain-ledger-shadow.mjs", "we:scripts/review-ledger-check.mjs", "we:scripts/lib/__tests__/pr-merge-gate-ledger.test.mjs", "we:scripts/lib/__tests__/drain-ledger-shadow.test.mjs", "we:scripts/__tests__/review-ledger-check.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — Run the per-repo reads concurrently under one overall deadline, and time the shadow with __t.time… (from web-everything/web-everything#4760 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/drain-ledger-shadow.mjs:128` — Run the per-repo reads concurrently under one overall deadline, and time the shadow with `__t.timeAsync` so the pass-timings line includes it. A test with several hanging repos should assert the total wall time stays under the bound.
2. `we:scripts/lib/drain-ledger-shadow.mjs` — Add a deterministic overflow test with more than MAX_ROWS disagreements that asserts the intended preservation or explicit omission accounting for their identities.
3. `we:scripts/review-ledger-check.mjs:403` — Add a deterministic runHistory test asserting that reader corruption and malformed-summary corruption both appear in the returned and rendered shadow totals.
4. `we:scripts/lib/__tests__/pr-merge-gate-ledger.test.mjs` — Add deterministic shadow integration tests mixing identical PR numbers across repositories and accepted rows across different heads.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4760@ed46b8fbbcb01e7723557f0a106f8c170557b7db

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
