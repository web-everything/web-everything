---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/__tests__/lane-pool.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add the clean-memo setting to listCacheKey (as reap= already is), or have the daemon pass --no-ca… (from web-everything/web-everything#4356 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lane-pool.mjs:2897` — Add the clean-memo setting to `listCacheKey` (as `reap=` already is), or have the daemon pass `--no-cache`. Add a test that a feature-on list result is not served to a feature-off caller from the list cache.
2. `we:scripts/lane-pool.mjs:2800` — Add a deterministic warm-cache versus full-scan regression test that creates a file inside a pre-existing empty directory, and make directory coverage sufficient to pass it.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4356@7f0bbe15280de6a1bb118aaeacc228f7b1a6c99e

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
