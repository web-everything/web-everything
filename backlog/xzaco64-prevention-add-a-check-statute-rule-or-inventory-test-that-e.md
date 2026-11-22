---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:docs/agent/platform-decisions.md"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Add a check:statute rule or inventory test that every "only/never/cannot" clause in a ruling cite… (from web-everything/web-everything#7310 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:docs/agent/platform-decisions.md:6158` — Add a `check:statute` rule or inventory test that every "only/never/cannot" clause in a ruling cites a planned case. Also add the missing `append`-refuses-`merge-intent` row to the PR 2 inventory.
2. `we:docs/agent/platform-decisions.md:6222` — Add one clause saying duplicates are matched on repo, PR and event id. Add a conformance case for a same-id row in another PR or repo. The conformance suite is the deterministic gate.
3. `we:docs/agent/platform-decisions.md:6159` — Add a conformance case or `validateLedgerStore` rule that `append` rejects `merge-intent` rows, and add it to the PR 2 inventory case. More broadly, a check:statute rule could require each 'only through X' or 'never' clause to cite a named case.
4. `we:docs/agent/platform-decisions.md:6216` — Add to the `appendIf_invalid_batch_writes_nothing` case, or a sibling case, that options with a non-integer, negative or missing `expectPrSeq`, or a missing or mismatched `repo` or `pr` type, refuse with `ok:false` and write nothing.
5. `we:docs/agent/platform-decisions.md:6218` — State in the contract that the event id is derived from the row content, or that a stored id with different content is a refused conflict. Add a conformance case for it. A write-gate check on statute clauses that say 'duplicate' could require the identity basis to be named.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7310@310441bf2e3191fd4b4444285d1dfca9e658d16e

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
