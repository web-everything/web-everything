---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/build-dispatch-policy.mjs", "we:scripts/lib/open-pr-cap-scope.mjs", "we:scripts/conveyor/__tests__/build-dispatch-policy.test.mjs", "we:scripts/lib/__tests__/open-pr-cap-scope.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Build the dry-run policy summary from plan.openPrCap or the policy instead of a hand-written stri… (from web-everything/web-everything#4680 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/build-dispatch-policy.mjs:50` — Build the dry-run policy summary from `plan.openPrCap` or the policy instead of a hand-written string, and add one test asserting that the string mentions the exclusions.
2. `we:scripts/lib/open-pr-cap-scope.mjs:48` — Have `open-pr-fetch` flag a file list at or above the gh cap (for example `filesTruncated`), and make `countOpenPrsForCap` count such a PR as non-card-only. Add a unit test for it.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4680@03dfba1fed8e48b19c57e948bdeda42ec1980918

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
