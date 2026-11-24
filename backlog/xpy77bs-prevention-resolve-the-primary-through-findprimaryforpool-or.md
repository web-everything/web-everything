---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/__tests__/lane-pool-wrong-origin.test.mjs", "we:scripts/__tests__/lane-pool.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Resolve the primary through findPrimaryForPool (origin-slug match) or accept the caller when its… (from web-everything/web-everything#7419 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lane-pool.mjs:473` — Resolve the primary through `findPrimaryForPool` (origin-slug match) or accept the caller when its origin slug equals the pool, instead of a name-joined path. Add a fixture test where the caller primary dir name differs from the pool name.
2. `we:scripts/lane-pool.mjs:1826` — A review lens or checklist item: every stated 'names its real cause' diagnostic gets one positive-assertion test on the emitted text.
3. `we:scripts/__tests__/lane-pool-wrong-origin.test.mjs:65` — Review lens: every acceptance bullet that says a message 'names X' needs a positive assertion on X. A deterministic gate is not practical here.
4. `we:scripts/__tests__/lane-pool-wrong-origin.test.mjs:88` — Parametrize the test with the same command list `resolveRepo` uses, for example by exporting `needsOrigin`'s command list. Check this at review.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7419@7145098251c4be13cddecd802f48f0d6cc58e6ba

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
