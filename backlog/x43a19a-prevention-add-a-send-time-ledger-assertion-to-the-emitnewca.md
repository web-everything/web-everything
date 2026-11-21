---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/stuck-prs.test.mjs", "we:scripts/conveyor/stuck-prs.mjs", "we:docs/agent/testing.md"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a send-time ledger assertion to the emitNewCauses tests. More generally, any code that carrie… (from web-everything/web-everything#7190 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/__tests__/stuck-prs.test.mjs:280` — Add a send-time ledger assertion to the `emitNewCauses` tests. More generally, any code that carries a 'reserve before append' comment should be paired with a test that reads the ledger from inside the sender.
2. `we:scripts/conveyor/stuck-prs.mjs:107` — Add a lint or review-lens rule that any persisted dedupe ledger must state how it is pruned or expired. Alternatively, add a test that fills the ledger to the cap and asserts the behaviour.
3. `we:docs/agent/testing.md:5755` — Tie prose guarantees to a named test, as the mandate suggests. A doc-lint is not realistic for this.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7190@cbd6c80250a0427c0b14776cccca6a08826fb39a

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
