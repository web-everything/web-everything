---
bornAs: xa0p0k1
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/merge-queue-adaptive-batching.mjs", "we:scripts/lib/__tests__/merge-queue-adaptive-batching.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Add a test that drives observe() end to end under HEADGREEN with supplied native groups and asser… (from web-everything/web-everything#5217 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/merge-queue-adaptive-batching.mjs:484` — Add a test that drives `observe()` end to end under HEADGREEN with supplied native groups and asserts a cancel POST. Alternatively, make the replay report label HEADGREEN savings as unachievable until the shell can read native group membership.
2. `we:scripts/lib/merge-queue-adaptive-batching.mjs:470` — Add `timeout` to the shell's ioOptions for the `execFileSync` calls, and have the contention path in `gate` fail open (admit with a warning) after N consecutive lock timeouts. A lint or standards rule could require a `timeout` on `execFileSync('gh', ...)` made inside `withPathLock` callbacks.
3. `we:scripts/lib/merge-queue-adaptive-batching.mjs` — Add a deterministic IO-shell regression test asserting zero ruleset/workflow discovery calls when native group boundaries are unavailable, including default auto and explicit on/off settings.
4. `we:scripts/lib/merge-queue-adaptive-batching.mjs:182` — Add a deterministic regression that performs two isolation gates against an empty queue, passes the first returned state into the second, and asserts the second is deferred until the first reservation completes or expires; run it in the required test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5217@071e88412c92592c8716c9191183e145135ae5f8

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
