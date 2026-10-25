---
bornAs: xnxnym8
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/verdict-ledger.mjs", "we:scripts/lib/ledger-observation.mjs", "we:scripts/lib/__tests__/verdict-ledger.test.mjs", "we:scripts/lib/__tests__/ledger-observation.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — Add a fold-level test (or a validator rule) that a carried row with no preceding clearing verdict… (from web-everything/web-everything#5492 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/verdict-ledger.mjs:1` — Add a fold-level test (or a validator rule) that a `carried` row with no preceding clearing verdict at `fromHead` does not clear. This could also go in the follow-up in card 6282.
2. `we:scripts/lib/ledger-observation.mjs:1` — Add a lint or check-standards rule that rejects `execFile*` argv built from unvalidated event fields. Failing that, validate `Number.isInteger(pr) && pr > 0` at the top of `observeLedgerPrEvent`.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5492@31cb7a5d863708e9523d1b7e278bb8640fd31d15

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
