---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/reconcile-pass-main-red-memo.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Have the card's Acceptance template separate offline-testable guarantees from live-verification i… (from web-everything/web-everything#7446 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/__tests__/reconcile-pass-main-red-memo.test.mjs:229` — Have the card's Acceptance template separate offline-testable guarantees from live-verification items. Live items go to a post-merge checklist or a recorded measurement artifact, not a test with a vacuous bound. That change is process-side, not a script gate. A lint rule that rejects `< N_000` timing bounds with stubbed sleeps under a threshold is another option.
2. `we:scripts/conveyor/__tests__/reconcile-pass-main-red-memo.test.mjs:230` — Add a named performance acceptance check that records cold and warm live planner timings and gates the warm threshold; calibrate the controlled regression benchmark so disabling memoization fails it.
3. `we:scripts/conveyor/__tests__/reconcile-pass-main-red-memo.test.mjs:226` — Add a deterministic benchmark assertion that fails when graph reads repeat, and require recorded live cold/warm enrich-main-red planner timings as acceptance evidence.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7446@4e1fbb1040647e4c22ae2b560916d530f5193f9e

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
