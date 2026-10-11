---
bornAs: xx9vw5s
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/main-red-recovery.mjs", "we:scripts/conveyor/ci-red-recovery-watch.mjs", "we:scripts/conveyor/__tests__/ci-red-recovery-watch.test.mjs", "we:scripts/conveyor/__tests__/main-red-recovery.test.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Prevention — A single shared helper (for example rebaseCapExhausted(comments, sha, ctx)) used by both reconcil… (from web-everything/web-everything#4825 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/main-red-recovery.mjs:773` — A single shared helper (for example rebaseCapExhausted(comments, sha, ctx)) used by both reconcile-core and the sweep, plus a test asserting the two agree for the green-sha-change case.
2. `we:scripts/conveyor/ci-red-recovery-watch.mjs:172` — Make prNumber required for refreshOntoMain, or fail closed when it is absent. Add a check:standards rule that every refreshOntoMain call site passes prNumber.
3. `we:scripts/conveyor/__tests__/ci-red-recovery-watch.test.mjs` — Add a deterministic three-link regression test with only the middle ancestor claimed, asserting zero refreshes and zero fetches; deleting ancestor claim checks must fail that test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4825@38524db3af0cbed6d773c6d58ed87fc346a14cec

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
