---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/review-seat-runner.mjs", "we:scripts/operations/__tests__/review-seat-runner.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — A reviewer lens that checks comments adjacent to changed conditionals. A prettier or lint check o… (from web-everything/web-everything#7255 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/review-seat-runner.mjs:56` — A reviewer lens that checks comments adjacent to changed conditionals. A prettier or lint check on operator spacing would catch the `=Object` formatting.
2. `we:scripts/operations/review-seat-runner.mjs:56` — Review lens: when a guard is removed or exempted, grep the enclosing function's comments for the guard's name.
3. `(no file cited)` — Require each acceptance item to reference a named implemented or planned test through a deterministic card-validation gate.
4. `(no file cited)` — Add a deterministic deferred-juror test that asserts review completion while the shadow promise remains unresolved.
5. `(no file cited)` — Add a named post-load acceptance check that asserts a qualifying Carbon shadow row within two hours, and require each acceptance criterion to reference a named automated or operational check.
6. `(no file cited)` — Add a deterministic integration test using a deferred shadow juror and assert that authoritative review completion occurs before that juror is released.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7255@3b31da0bf78c6d815cde9e13d45b59d322a45431

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
