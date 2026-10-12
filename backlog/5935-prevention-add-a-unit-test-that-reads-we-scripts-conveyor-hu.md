---
bornAs: xlhrix0
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/hung-session-mutation-check.test.mjs", "we:scripts/conveyor/hung-session-mutation-check.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Prevention — Add a unit test that reads we:scripts/conveyor/hung-session.mjs and asserts each DEFAULT_MUTATION… (from web-everything/web-everything#5019 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/__tests__/hung-session-mutation-check.test.mjs:8` — Add a unit test that reads we:scripts/conveyor/hung-session.mjs and asserts each DEFAULT_MUTATIONS.find occurs exactly once. Better, run the checker from a gate or CI script so drift is caught automatically.
2. `we:scripts/conveyor/hung-session-mutation-check.mjs:111` — Add a deterministic parameterized test that makes each rmSync call throw in turn and verifies that every subsequent cleanup is still attempted.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5019@ab6f6cc4db14ec1435f4f72b713b9207523b4760

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
