---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/review-red-team-on-skip.mjs", "we:scripts/lib/card-only-head-move.mjs", "we:scripts/lib/__tests__/review-red-team-on-skip.test.mjs", "we:scripts/lib/__tests__/card-only-head-move.test.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — Add a doc-claim-to-test mapping check, or delete the dead clause and fix the doc sentence. (from web-everything/web-everything#5952 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/review-red-team-on-skip.mjs:181` — Add a doc-claim-to-test mapping check, or delete the dead clause and fix the doc sentence.
2. `we:scripts/lib/review-red-team-on-skip.mjs:290` — Test the failure path of a two-step publish (post, then sync). Alternatively, make the 'result already on head' skip also run an idempotent label sync.
3. `we:scripts/lib/card-only-head-move.mjs:25` — Add a deterministic regression matrix for 20 versus 21 commits and card/code changes at different positions in a multi-commit history.
4. `we:scripts/lib/__tests__/review-red-team-on-skip.test.mjs` — Build these cases from a fixture that demonstrably clears, then vary only the seat or deferral evidence and assert that publication and label synchronization remain absent.
5. `we:scripts/lib/card-only-head-move.mjs:26` — Add deterministic multi-commit boundary tests and a targeted mutation gate that removes the commit-count refusal or limits inspection to one commit; require the corresponding named tests to fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5952@a0d12816742b7106ee1916493c7ffe43accfffc6

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
