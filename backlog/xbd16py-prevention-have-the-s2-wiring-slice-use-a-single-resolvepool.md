---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/resource-pool.mjs", "we:scripts/lib/__tests__/resource-pool.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Have the S2 wiring slice use a single resolvePoolGrant(settings, budget, request) entry point tha… (from web-everything/web-everything#7383 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/resource-pool.mjs:14` — Have the S2 wiring slice use a single `resolvePoolGrant(settings, budget, request)` entry point that takes the loader result whole, with a test that drops the flag. A lint that rejects `grantDecision` calls without an `unknown` key would also work.
2. `we:scripts/lib/__tests__/resource-pool.test.mjs:1` — Add a `check:standards` rule or test that allowlists the importers of we:scripts/lib/resource-pool.mjs and we:resource-pool-io.mjs until the enforcement slice lands.
3. `we:scripts/lib/__tests__/resource-pool.test.mjs:1` — Add a check:standards rule or import-allowlist test: only the listed modules may import `we:scripts/lib/resource-pool.mjs` grant exports while the mode is shadow-only.
4. `we:scripts/lib/resource-pool.mjs:16` — Make `unknown`, `classes` and `builderFloor` required inputs (a missing value means unknown/hold), or have the settings loader return a decision-ready object. Add a test that omitting them holds.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7383@954d13e87293310ce9cb809dce75881fbaeed497

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
