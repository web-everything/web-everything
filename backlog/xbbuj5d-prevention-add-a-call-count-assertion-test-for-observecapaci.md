---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/provider-capacity-io.mjs", "we:scripts/lib/provider-capacity.test.mjs", "we:scripts/lib/__tests__/provider-capacity-io.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Add a call-count assertion test for observeCapacity's per-read snapshot. A review lens asking for… (from web-everything/web-everything#7341 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/provider-capacity-io.mjs:53` — Add a call-count assertion test for observeCapacity's per-read snapshot. A review lens asking for a named test for each prose guarantee is the cheapest durable check, since no deterministic gate can detect an untested comment.
2. `we:scripts/lib/provider-capacity-io.mjs:53` — Add a deterministic test using a reader that returns different values on successive calls; assert one invocation and identical evidence across accounts and aliases.
3. `we:scripts/lib/provider-capacity.test.mjs` — Give the fixture valid account attribution, assert that the same reading at now is known, and add a deterministic mutation check that granting Claude future skew fails this test.
4. `we:scripts/lib/provider-capacity-io.mjs:53` — Add a deterministic test using a reader that returns different values on successive calls; assert one call per source, identical alias observations, and a fresh call on the next observeCapacity invocation.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7341@a30856f5d257443e82135fdcccb518908064b1de

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
