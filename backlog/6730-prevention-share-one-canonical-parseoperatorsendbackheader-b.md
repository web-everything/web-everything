---
bornAs: xistuzc
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/operator-send-backs.mjs", "we:scripts/lib/__tests__/operator-send-backs.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Share one canonical parseOperatorSendBackHeader between operatorFixBudget and the ledger (or deri… (from web-everything/web-everything#5356 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/operator-send-backs.mjs:23` — Share one canonical `parseOperatorSendBackHeader` between operatorFixBudget and the ledger (or derive both from the producer), and add a table-driven test over both producer shapes.
2. `we:scripts/lib/operator-send-backs.mjs:28` — Fall back to the head at comment time, or accept operator-authored evidence without a head comparison, and add a test that an unknown-head send-back is clearable.
3. `we:scripts/lib/operator-send-backs.mjs:62` — Require a recorded evidence head, or another immutable association with that head, and gate resolution with a regression that advances the PR head without adding evidence.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5356@a33991e277ae244aea07b170bfd2caec71e89981

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
