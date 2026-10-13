---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/ruling-needed-sweep.mjs", "we:scripts/conveyor/review-hold-reconcile.mjs", "we:scripts/conveyor/__tests__/ruling-needed-sweep.test.mjs", "we:scripts/conveyor/__tests__/review-hold-reconcile.test.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Add a read-budget test per sweep (a count of live reads against a fixed list of N PRs) and a back… (from web-everything/web-everything#5107 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/ruling-needed-sweep.mjs:64` — Add a read-budget test per sweep (a count of live reads against a fixed list of N PRs) and a backlog item to measure and bound the extra reads.
2. `we:scripts/conveyor/review-hold-reconcile.mjs:231` — Add a composed dry-run test using a PR with no label and a pending referral, asserting dry-run and real entries match.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5107@abbacda65b1442983f9df4bc874f8c6917d058be

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
