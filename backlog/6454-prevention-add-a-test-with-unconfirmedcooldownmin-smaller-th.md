---
bornAs: xkcypq5
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/build-dispatch-failures.mjs", "we:scripts/lib/build-unconfirmed-settings.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-non-blocking-launch.test.mjs", "we:scripts/conveyor/__tests__/build-dispatch-failures.test.mjs", "we:scripts/lib/__tests__/build-unconfirmed-settings.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Add a test with unconfirmedCooldownMin smaller than the backoff window, asserting retryAfter is n… (from web-everything/web-everything#5472 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/build-dispatch-failures.mjs:124` — Add a test with unconfirmedCooldownMin smaller than the backoff window, asserting retryAfter is never earlier than the plain verdict's.
2. `we:scripts/conveyor/build-dispatch-failures.mjs:99` — Add a test with a null base: record unconfirmed with base null twice and assert the cooldown fires. Also cover an interleaved null base.
3. `we:scripts/lib/build-unconfirmed-settings.mjs:9` — Add a test that readBuildUnconfirmedSettings() with no overrides returns the values in we:build-unconfirmed.json.
4. `we:scripts/conveyor/build-dispatch-failures.mjs:128` — Cap unconfirmedCooldownMin to a sane upper bound (for example 10080 minutes) in the `valid` predicate of we:scripts/lib/build-unconfirmed-settings.mjs, and add a cascade test for an over-range value falling through to the next layer.
5. `we:skills-src/conveyor/__tests__/build-dispatch-non-blocking-launch.test.mjs` — Add a table-driven cascade test requiring distinct sentinel values for each layer and each setting, including both valid environment overrides.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5472@e3fbe6142e86717efd75c1bbaf76c96a173e020d

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
