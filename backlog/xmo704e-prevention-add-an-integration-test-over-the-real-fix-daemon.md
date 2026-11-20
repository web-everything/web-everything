---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/__tests__/review-set-label.accept-keeps-sendback.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — Add an integration test over the real fix-daemon planner (for example the orphan-fix-round/reconc… (from web-everything/web-everything#7210 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/__tests__/review-set-label.accept-keeps-sendback.test.mjs:373` — Add an integration test over the real fix-daemon planner (for example the orphan-fix-round/reconcile-core planner) that takes a PR state of review:changes + same-head sent-back gate + refused-accept comment and asserts a fix dispatch is planned. Track it as a follow-up card.
2. `we:scripts/__tests__/review-set-label.accept-keeps-sendback.test.mjs:383` — A check:standards rule that fails when a PR's Acceptance names a guarantee covered only by it.todo or prose, unless the card carries a filed follow-up id. Alternatively, add a contract test that asserts the refusal result shape the fix daemon consumes.
3. `we:scripts/__tests__/review-set-label.accept-keeps-sendback.test.mjs` — Implement the planned test asserting refusal, preserved review:changes, and a durable daemon claim/session for the same repo/PR/head; gate acceptance-test completion on executable cases rather than todo declarations.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7210@b02aa114e424a276ea81d7dc79b433e32ea448e0

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
