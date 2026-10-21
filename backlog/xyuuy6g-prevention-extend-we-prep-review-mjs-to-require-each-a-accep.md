---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/xzr443y-operator-binding-fixer-input-can-be-added-to-a-pr-already-in.md"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Extend we:prep-review.mjs to require each [A#] Acceptance line to name a test file path or test-c… (from web-everything/web-everything#5557 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/xzr443y-operator-binding-fixer-input-can-be-added-to-a-pr-already-in.md:19` — Extend we:prep-review.mjs to require each [A#] Acceptance line to name a test file path or test-case identifier.
2. `we:backlog/xzr443y-operator-binding-fixer-input-can-be-added-to-a-pr-already-in.md:1` — we:prep-review.mjs already gates on Done-when and edge-case classes. Adding a check for a Risks-to-Test-plan mapping would cover this.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 3 → #5360, finding 4 → #5360.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5557@5e228ff4d27376ebf07e5f0f9fbfa5bf35bc2f9b

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
