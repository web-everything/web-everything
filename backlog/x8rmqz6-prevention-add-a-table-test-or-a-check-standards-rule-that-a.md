---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/git-fetch-retry.test.mjs", "we:scripts/lib/git-fetch-retry.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add a table test, or a check:standards rule, that asserts every fetch run through the conveyor gi… (from web-everything/web-everything#4345 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/git-fetch-retry.test.mjs:57` — Add a table test, or a check:standards rule, that asserts every `fetch` run through the conveyor git wrappers goes through retryTransientGit or withFetchRetry. Alternatively, route all conveyor fetches through one wrapper so one test covers them.
2. `we:scripts/lib/git-fetch-retry.mjs:38` — Add a deterministic table-driven test covering compare-and-swap contention, existing lock files, and permanent ref namespace conflicts; restrict transient tagging to the recoverable signatures.
3. `we:scripts/lib/__tests__/git-fetch-retry.test.mjs:26` — Add a deterministic default-options exhaustion test using an empty environment, injected sleep, and a sentinel that fails if calls exceed five.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4345@4027545466a0f203ed759a33ec33dcc3f299cc4b

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
