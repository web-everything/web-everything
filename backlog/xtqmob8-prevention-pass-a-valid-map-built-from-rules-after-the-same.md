---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/verify-settings.mjs", "we:docs/agent/testing.md", "we:scripts/__tests__/verify-lane.test.mjs", "we:scripts/lib/__tests__/verify-settings.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — Pass a valid map built from rules (after the same split/trim parse) into cascadePolicy's envValue… (from web-everything/web-everything#7584 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/verify-settings.mjs:151` — Pass a `valid` map built from `rules` (after the same split/trim parse) into cascadePolicy's envValues for verify. Add a table-driven test that, for every value in the malformed-override table, checks that the cascade log's provenance matches resolveVerifySettings().sources.alwaysRunTests.
2. `we:docs/agent/testing.md:6425` — Add the named integration test to the automated suite, asserting that a selected test executes with tool-file alwaysRunTests set to [].
3. `we:scripts/__tests__/verify-lane.test.mjs:79` — Add the named automated test using conflicting verifier-root and target-cwd settings without replacing the settings loader.
4. `we:docs/agent/testing.md:6425` — Add an execution-level regression test asserting selected tests run with an explicit empty guard policy, and include it in the verification gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7584@e6cf2b38c2a0c24c31f8fea1464c1198d0a2769a

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
