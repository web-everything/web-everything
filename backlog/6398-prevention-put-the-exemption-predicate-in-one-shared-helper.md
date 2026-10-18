---
bornAs: xf35wve
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/pr-state.mjs", "we:scripts/lib/ledger-observation.mjs", "we:scripts/lib/__tests__/pr-state.test.mjs", "we:scripts/lib/__tests__/ledger-observation.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — Put the exemption predicate in one shared helper, for example ledgerReviewExempt(folded, events,… (from web-everything/web-everything#5492 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/pr-state.mjs:60` — Put the exemption predicate in one shared helper, for example `ledgerReviewExempt(folded, events, head)`, and use it in pr-state, pr-merge-gate and drain-ledger-facts. Add a test that runs the same stream through derivePrState and ledgerVerdict.
2. `we:scripts/lib/ledger-observation.mjs:38` — Add a per-guard mutation probe or table test for proveLedgerCarry (each setting off yields null). This could be folded into the existing xjdyood guard-inventory card.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5492@61e54fe6ba70db8784a85ac1ec08679e1b71849f

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
