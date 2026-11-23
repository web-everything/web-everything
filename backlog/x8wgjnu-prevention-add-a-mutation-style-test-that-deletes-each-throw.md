---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/resource-pool-io.mjs", "we:scripts/lib/resource-pool.mjs", "we:scripts/lib/__tests__/resource-pool-io.test.mjs", "we:scripts/lib/__tests__/resource-pool.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a mutation-style test that deletes each throw guard in readPoolSource and fails if no test go… (from web-everything/web-everything#7382 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/resource-pool-io.mjs:116` — Add a mutation-style test that deletes each `throw` guard in readPoolSource and fails if no test goes red. Until then, add one test per throw branch.
2. `we:scripts/lib/resource-pool-io.mjs:27` — Add a shared helper that mocks `readdirSync` to return N entries, and use it in an `it.each` over every capped source.
3. `we:scripts/lib/resource-pool.mjs:4` — Add the named regression test to the required test gate, asserting successful evaluation and identical uncapped units for zero and negative growth.
4. `we:scripts/lib/resource-pool-io.mjs:22` — Extend the named test with a recording readSync fake and assertions that requested ranges and cumulative bytes stay within the initial file size plus one and the absolute limit, including partial reads.
5. `we:scripts/lib/resource-pool.mjs:4` — Add a deterministic parameterized test using uncapped headroom and exact expected unit counts for zero, positive, and negative swap growth.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7382@1f91ecd9d394bfba263e4e863f83225da3805a45

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
