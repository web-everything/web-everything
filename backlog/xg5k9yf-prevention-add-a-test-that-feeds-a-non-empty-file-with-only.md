---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/verdict-ledger-io.mjs", "we:scripts/lib/__tests__/verdict-ledger-io.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add a test that feeds a non-empty file with only invalid rows to readLedgerFromGit. Have the read… (from web-everything/web-everything#4268 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/verdict-ledger-io.mjs:52` — Add a test that feeds a non-empty file with only invalid rows to readLedgerFromGit. Have the reader report the dropped-row count, or return unreadable when text is non-empty and records is empty.
2. `we:scripts/lib/verdict-ledger-io.mjs:52` — Have readLedgerFromGit report a skipped-line count (or return 'unreadable' when non-blank lines were dropped), and add a test with garbage-only and mixed content. A review lens on fail-open reads of security-relevant stores would also catch it.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4268@9035d3a9859f349f95c8bd49920e1c83193dedd5

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
