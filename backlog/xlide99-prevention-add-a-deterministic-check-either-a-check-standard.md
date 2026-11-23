---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/resource-pool.test.mjs", "we:scripts/lib/resource-pool-io.mjs", "we:scripts/lib/__tests__/resource-pool-io.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a deterministic check, either a check:standards rule or a unit test, that asserts the importe… (from web-everything/web-everything#7383 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/resource-pool.test.mjs:1` — Add a deterministic check, either a check:standards rule or a unit test, that asserts the importers of we:resource-pool.mjs and we:scripts/lib/resource-pool-io.mjs are limited to an allowlist during S1a.
2. `we:scripts/lib/resource-pool-io.mjs:158` — Before S2, make the settings result poison itself, for example by returning classes:null when unknown, or add one decide(settings, request) entry point. Add a test that omits unknown.
3. `we:scripts/lib/__tests__/resource-pool.test.mjs:88` — Add a variant of the test that passes only `budget: budget.units` and asserts a hold. Optionally add a repo check that no grant call site imports `resource-pool-io`.
4. `we:scripts/lib/__tests__/resource-pool.test.mjs:85` — Add `resource pool decisions have only observation consumers` in we:scripts/lib/__tests__/resource-pool.test.mjs as a deterministic CI dependency check permitting only explicitly identified observation consumers.
5. `we:scripts/lib/resource-pool-io.mjs:114` — Add a deterministic parameterized test crossing each prohibited lower-layer mode with valid higher-layer overrides, asserting unknown:true and a hold decision.
6. `we:scripts/lib/__tests__/resource-pool.test.mjs:1` — Add a deterministic dependency gate restricting grantDecision consumers to approved observation modules and tests until enforcement is implemented.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7383@7ad3e6649f0fdd501bdbade71a00e74ed098c5fd

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
