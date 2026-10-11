---
bornAs: xnss034
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:src/wip/shared-source.ts", "we:src/wip/__tests__/shared-source.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — Add a gate test whose read outlasts debounceMs and a signal arrives mid-read. It should assert that a not… (from plateauapp/plateau-app#223 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:src/wip/shared-source.ts:172` — Add a gate test whose read outlasts debounceMs and a signal arrives mid-read. It should assert that a notification fires after the read resolves. As a fix, have the timer callback skip while `inFlight` is set and let `rebuilt()` re-arm via `schedule()`, or have `rebuilt()` re-notify when `dirty` is true.
2. `we:src/wip/shared-source.ts` — Add a deterministic fake-timer regression test that signals a cached source, calls read repeatedly before minGapMs, and verifies that the underlying reader runs again only after the floor expires.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#223@e992f92b30475879c9b569de3af0c298981fdab2

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
