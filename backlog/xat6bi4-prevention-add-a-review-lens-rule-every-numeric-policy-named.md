---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-version-runtime.mjs", "we:scripts/lib/__tests__/daemon-version-runtime.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add a review-lens rule: every numeric policy named in a PR description (backoff, cap, TTL) needs… (from web-everything/web-everything#4235 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-version-runtime.mjs:157` — Add a review-lens rule: every numeric policy named in a PR description (backoff, cap, TTL) needs a test asserting its boundary values. A `check:standards` rule cannot decide this mechanically.
2. `we:scripts/lib/__tests__/daemon-version-runtime.test.mjs:77` — Assert that no read targets the escaped path, and add a targeted mutation check that removes the ID validation and requires this test to fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4235@f980a698ec5d7b2daa37643629116b19625ae2fe

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
