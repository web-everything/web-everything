---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/review-ledger-check.mjs", "we:scripts/__tests__/review-ledger-check.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Treat any non-empty probeErrors as unreadable, or have readPrFacts expose a structured 'degraded'… (from web-everything/web-everything#4405 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/review-ledger-check.mjs:225` — Treat any non-empty probeErrors as unreadable, or have readPrFacts expose a structured 'degraded' flag. Add a table-driven test over each probe error string in we:pr-state-io.mjs.
2. `we:scripts/__tests__/review-ledger-check.test.mjs:157` — Add a deterministic CLI integration test that records external commands and rejects PR or label mutations; verify it fails when a mutation command is deliberately introduced.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4405@72020d9ac050c73b8c78a3995a4940f82d65a051

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
