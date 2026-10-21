---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/drain-ledger-facts.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/lib/__tests__/drain-ledger-facts.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Add a drain wiring test that runs a fake-gh pass and asserts the ledger rows. A cheaper alternati… (from web-everything/web-everything#5195 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/merge-ai-prs.mjs:5703` — Add a drain wiring test that runs a fake-gh pass and asserts the ledger rows. A cheaper alternative is a check:standards rule that every export in drain-ledger-*.mjs is referenced by a wiring test.
2. `we:scripts/merge-ai-prs.mjs:3092` — Add a decision-table test for the recorders covering the read-ok/write-miss product across consecutive passes. Optionally dedup the home spill by (pr, reasonCode, last event) when the miss flag is set.
3. `we:scripts/lib/drain-ledger-facts.mjs:47` — Add a decision-table test for `planDrainLedgerFacts` that crosses `reviewGate` facts with `decision` values (merge, skip, held) and asserts each fact kind's write or no-write. Also gate the restamp on `v.decision === 'merge'`.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5195@20579a25576d5e07af60023a4a27033ab9c1e241

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
