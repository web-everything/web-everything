---
bornAs: xw57r7q
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/gh-rest-read.mjs", "we:scripts/lib/__tests__/gh-rest-read.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add boundary tests for each guard clause: 4xx with cache, 5xx without cache, and retry-also-fails… (from web-everything/web-everything#4289 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/gh-rest-read.mjs:160` — Add boundary tests for each guard clause: 4xx with cache, 5xx without cache, and retry-also-fails. A review lens that asks 'for each stated guard, which test turns red if it is removed?' would also catch this.
2. `we:scripts/lib/__tests__/gh-rest-read.test.mjs:73` — Add a deterministic regression test for two consecutive failures after seeding the conditional cache, asserting the propagated error and exact call count.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4289@d308c216f25e7760bf56edb7e54b02122a15b46d

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
