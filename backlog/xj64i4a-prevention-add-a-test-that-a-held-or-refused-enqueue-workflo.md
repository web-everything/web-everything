---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/drain-merge-strategy.mjs", "we:scripts/lib/__tests__/merge-gate-ci.test.mjs", "we:scripts/lib/__tests__/drain-merge-strategy.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — Add a test that a held or refused enqueue (workflow-edit, head-moved) posts no clearance comment.… (from web-everything/web-everything#4717 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/drain-merge-strategy.mjs:196` — Add a test that a held or refused enqueue (workflow-edit, head-moved) posts no clearance comment. Alternatively, have enqueuePr expose a pre-flight hold check that runs before the stamp.
2. `we:scripts/lib/__tests__/merge-gate-ci.test.mjs` — Add a test lint rule rejecting assertions against extracted workflow comment headers; retain assertions against parsed workflow configuration and executable behavior.
3. `we:scripts/lib/drain-merge-strategy.mjs:212` — Persist a recoverable enqueue intent before the external mutation, and add a deterministic fault-injection test that interrupts persistence, marks the PR merged before restart, and asserts its follow-up is recovered. This guard needs a future backlog filing; none was made in this read-only review.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4717@7b538f103a4210ff4cf0f45e63b18b402142ad94

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
