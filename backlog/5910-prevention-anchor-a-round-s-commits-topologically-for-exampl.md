---
bornAs: x7qti4d
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/mechanical-round-cap.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs", "we:scripts/conveyor/__tests__/mechanical-round-cap.test.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Prevention — Anchor a round's commits topologically, for example by the head SHA recorded at each re-arm or fi… (from web-everything/web-everything#4914 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-core.mjs:490` — Anchor a round's commits topologically, for example by the head SHA recorded at each re-arm or fix-begin. Or refund only when every commit new since the previous re-arm's recorded head is mechanical, and treat any commit whose date falls outside the window as real. Add a test with a backdated real commit plus an in-window merge that must stay spent.
2. `we:scripts/conveyor/mechanical-round-cap.mjs:405` — Add an overall deadline or a merge-count cap in `readRoundCommits` that fails closed with `walk-limit`. Add a test that a line with many merges fails closed.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4914@e4931727e2ae74dd475c1a1057955ef6be72ac3b

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
