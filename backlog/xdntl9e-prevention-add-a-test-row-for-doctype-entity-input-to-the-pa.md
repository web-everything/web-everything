---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/actions-policy-watch.test.mjs", "we:scripts/conveyor/actions-policy-watch.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add a test row for DOCTYPE/ENTITY input to the parseFeed rejection table. Also add a review-lens… (from web-everything/web-everything#7473 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/__tests__/actions-policy-watch.test.mjs:28` — Add a test row for DOCTYPE/ENTITY input to the parseFeed rejection table. Also add a review-lens rule that every 'fails closed on X' comment needs a test row naming X.
2. `we:scripts/conveyor/__tests__/actions-policy-watch.test.mjs` — Build the fixtures from the healthy policy helper and add a targeted mutation gate requiring removal of the ID check to fail this named test.
3. `we:scripts/conveyor/actions-policy-watch.mjs` — Add a deterministic regression test using an otherwise valid feed containing a DTD and require it in the scoped suite.
4. `we:scripts/conveyor/__tests__/actions-policy-watch.test.mjs` — Build these cases from an otherwise valid policy fixture, vary only id, and add a targeted mutation gate requiring removal of the ID comparison to fail this named test.
5. `we:scripts/conveyor/actions-policy-watch.mjs` — Add DTD fixtures to the mandatory parser regression suite, including an otherwise valid feed with a DOCTYPE, and require their rejection in CI.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7473@6e315e79fe3b898b81e7a1c733326be628d566e0

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
