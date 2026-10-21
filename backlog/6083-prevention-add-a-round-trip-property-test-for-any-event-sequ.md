---
bornAs: xhcsaah
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/drain-ledger-facts.mjs", "we:scripts/lib/pr-state.mjs", "we:scripts/lib/__tests__/drain-ledger-facts.test.mjs", "we:scripts/lib/pr-state/__tests__/pr-state.test.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Add a round-trip property test: for any event sequence the drain plans, the planned rows followed… (from web-everything/web-everything#5195 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/drain-ledger-facts.mjs:42` — Add a round-trip property test: for any event sequence the drain plans, the planned rows followed by derivePrState must clear at the live head. This holds for revisited-head sequences too.
2. `we:scripts/lib/drain-ledger-facts.mjs:44` — Have the review gate expose a structured `carried: {from, to, verifiedByNetDiff}` field and plan restamps only from it. Add a test that a skip decision writes no restamp.
3. `we:scripts/lib/pr-state.mjs:58` — Record the escalation-rule or settings version in the exemption and treat a mismatch as a hold. Add a test that a changed rule version stops the exemption clearing.
4. `we:scripts/lib/drain-ledger-facts.mjs:40` — Add a deterministic A → B → A recorder-and-derivation regression test, and deduplicate against the latest exemption rather than any historical matching exemption.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5195@9eeab963ac7875844755d67b2c97328a98d7eab6

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
