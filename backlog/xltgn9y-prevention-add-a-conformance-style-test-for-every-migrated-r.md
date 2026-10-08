---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/pr-status.mjs", "we:scripts/review-ledger-check.mjs", "we:scripts/lib/verdict-ledger-io.mjs", "we:scripts/lib/verdict-ledger.mjs", "we:scripts/__tests__/pr-status.test.mjs", "we:scripts/__tests__/review-ledger-check.test.mjs", "we:scripts/lib/__tests__/verdict-ledger-io.test.mjs", "we:scripts/lib/__tests__/verdict-ledger.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add a conformance-style test for every migrated reader that stubs an unreadable store and asserts… (from web-everything/web-everything#4498 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/pr-status.mjs:862` — Add a conformance-style test for every migrated reader that stubs an unreadable store and asserts the degraded output. Add a lint that fails when a function with an offline flag calls a network-reading API without branching on it.
2. `we:scripts/review-ledger-check.mjs:319` — Until the backfill lands, make the checker surface the gap. Either add a home-vs-git reconciliation (a home row id missing from git is a warning, or exit 1 for holds), or add a test where home holds a hold that git lacks and the checker must flag it. File this as a backlog item and gate the readStore default flip on the backfill.
3. `we:scripts/lib/verdict-ledger-io.mjs:160` — Normalise `error` once in `readLedgerEventsFromStore` and in `appendGitRowsSync`, at the point where store results are consumed, and add a conformance case that a multi-line error from a store comes back as a single capped line.
4. `we:scripts/lib/verdict-ledger.mjs:1478` — Add a deterministic contention test that forces failed lock acquisition and interleaves duplicate writers; require serialization or refuse the append when exclusivity cannot be obtained.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4498@bfe2f9359a39663dee25190df88d4a0bc4f6befb

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
