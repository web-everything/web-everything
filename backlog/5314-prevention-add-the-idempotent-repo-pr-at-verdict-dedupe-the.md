---
bornAs: xcrn1n0
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/verdict-ledger.mjs", "we:scripts/lib/__tests__/verdict-ledger.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add the idempotent (repo + PR + at + verdict) dedupe the backlog backfill item already designs to… (from web-everything/web-everything#4311 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/verdict-ledger.mjs:1150` — Add the idempotent (repo + PR + at + verdict) dedupe the backlog backfill item already designs to appendLedgerRows, and have the read slice ignore a clearing git row that has no matching label. Add a test that a git-landed and home-failed append followed by a retry yields one effective clearing row.
2. `we:scripts/lib/verdict-ledger.mjs:1110` — Have resolveLedgerBoard return a tri-state (board, not-board, unknown). Fail closed for clearing verdicts on 'unknown', and add a test that injects a throwing or empty probe on the repo's own checkout.
3. `we:scripts/lib/verdict-ledger.mjs:1125` — Make the git append idempotent (key on repo, PR, `at` and verdict) and reuse the record's `at` on retry. The backlog's backfill dedupe key covers this, so add a test that a retry after a home failure does not duplicate the git row.
4. `we:scripts/lib/__tests__/verdict-ledger.test.mjs:1010` — Add a shared beforeEach in the verdict-ledger suite that deletes WE_VERDICT_LEDGER_BOARD and WE_VERDICT_LEDGER_STORE. A standards rule could also flag any test that passes a store to appendVerdict without a gitAppend seam or a board.
5. `we:scripts/lib/__tests__/verdict-ledger.test.mjs` — Add a deterministic fixture test that first probes a missing checkout, then creates a checkout with the matching origin at that same path and asserts that resolution succeeds; require it in the unit-test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4311@47f3700ea78e3851be1ee0c1eaaf7261a20c7e32

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
