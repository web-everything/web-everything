---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/__tests__/land-prevention-card.test.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Prevention — Add one row per OR'd clause of the predicate to the table. Longer term, run a mutation check on f… (from web-everything/web-everything#7537 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/__tests__/land-prevention-card.test.mjs:131` — Add one row per OR'd clause of the predicate to the table. Longer term, run a mutation check on fail-closed predicates in `scripts/operations`.
2. `we:scripts/operations/__tests__/land-prevention-card.test.mjs:112` — Add table cases that vary one verdict field at a time (ok, code, stderr), or a small lint or review-lens rule that each clause of a fail-closed conjunction needs a case that fails only that clause.
3. `we:scripts/operations/__tests__/land-prevention-card.test.mjs:144` — Drop the git-diff assertion and keep the behavioural gate assertion. Alternatively, pin the gate with a content hash or a dedicated gate test.
4. `we:scripts/operations/__tests__/land-prevention-card.test.mjs:148` — Add a deterministic test lint rejecting worktree-cleanliness assertions; perform change-scope checks separately against explicit base and head revisions.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7537@a1c3c5fc63ebf765378ff3aef620596afba28bf8

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
