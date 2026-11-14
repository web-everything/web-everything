---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/rearm-review.mjs", "we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-11-13"
tags: []
---

# Cap repeated empty fix rounds that the empty-round guard leaves uncounted

The empty-round guard in we:scripts/conveyor/rearm-review.mjs (PR for #6713) refuses a re-arm when the head did not move since fix-begin and posts a no-change note instead of a counted re-arm. Round counters read re-arm markers, so repeated empty fixes are bounded by nothing and the reconciler can redispatch forever. Add a separate cap that counts the no-change notes and escalates, and make the guard refuse (not fail open) when the thread is unreadable or a stray positional argument is present.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/conveyor/__tests__/rearm-review.test.mjs`: a test that three consecutive no-change notes on one head escalate instead of redispatching.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change what counts as a real fix round; only bounds the empty ones.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — count only no-change notes from trusted authors.
2. **Truncated reads** — read the full paginated thread; a partial read refuses the re-arm.
3. **Shared state files** — n/a: the count lives on the PR thread, no state file.
4. **Fail closed** — an unreadable thread or a stray positional argument refuses the re-arm.
5. **Identity scoping** — count per PR and per head sha.
6. **State over time** — the count resets when the head moves.
7. **Who wrote it** — trusted-author check as in countRearmComments.
