---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/supersede-watch.mjs", "we:scripts/conveyor/__tests__/supersede-watch.test.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Prevention — Add a test whose listed author is web-everything[bot] and whose snapshot author is web-everything… (from web-everything/web-everything#7559 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/supersede-watch.mjs:117` — Add a test whose listed author is `web-everything[bot]` and whose snapshot author is `web-everything`. Normalise through a shared login-normaliser from we:marker-authorship.mjs instead of an ad hoc `app/` strip.
2. `we:scripts/conveyor/supersede-watch.mjs:36` — File a follow-up for a stable cursor or `mergedAt`-bounded GraphQL search for the merged side. Add a test or metric that asserts the call count stays bounded for a large closed inventory.
3. `we:scripts/conveyor/__tests__/supersede-watch.test.mjs:330` — A mutation-testing step per guarded predicate. At minimum, a standards rule that rejects `.every(...)` on a possibly empty array without a length assertion.
4. `we:scripts/conveyor/supersede-watch.mjs:183` — Add a default-wiring test where the closed-state count disagrees with the listing and the open path is clean, expecting a blocked result. A lint that flags a `requireComplete = false` default on authority readers would also catch this class.
5. `we:scripts/conveyor/supersede-watch.mjs:175` — A check in the card's test plan that lists every `throw new Error(...retry...)` site in the touched file against a test name. Lacking that, a review-lens checklist item.
6. `we:scripts/conveyor/supersede-watch.mjs:196` — A per-field mutation table for the pre-write comparison, with one case per compared field. This is a review lens; a deterministic gate is impractical.
7. `we:scripts/conveyor/supersede-watch.mjs:36` — Add a deterministic regression test named 'complete merged inventory continues beyond an old full page' in we:scripts/conveyor/__tests__/supersede-watch.test.mjs, asserting the requested pages and final count query.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7559@0612240c9f596a7f39d347947b9f4189fb209556

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
