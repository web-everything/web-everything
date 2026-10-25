---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/review-extra-seats.mjs", "we:scripts/operations/__tests__/review-extra-seats.test.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — Add a test whose fake gh emits an empty stderr and fails with a populated error (for example, by… (from web-everything/web-everything#5906 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/review-extra-seats.mjs:1772` — Add a test whose fake gh emits an empty stderr and fails with a populated error (for example, by exceeding a deliberately small maxBuffer), and assert the error message appears in the thrown text. A lint rule against `??` on stderr or stdout string fallbacks would catch the whole class.
2. `we:scripts/operations/review-extra-seats.mjs:1773` — Add a gh-helper test that injects a fake gh which writes nothing to stderr and exceeds a small maxBuffer or times out. It should assert that the thrown message contains the spawn error code. A pre-merge mutation check that each changed operator flips at least one test would catch this class.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5906@d4815a60360853acca8d2e761996cdadb24dd0a5

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
