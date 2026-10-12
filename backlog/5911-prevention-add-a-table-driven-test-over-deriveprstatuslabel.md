---
bornAs: x0zkknn
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/pr-status-label.mjs", "we:scripts/conveyor/review-status-tag.mjs", "we:scripts/conveyor/__tests__/pr-status-label.test.mjs", "we:scripts/conveyor/__tests__/review-status-tag.test.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Prevention — Add a table-driven test over derivePrStatusLabel that sets a historical durable marker (stand-dow… (from web-everything/web-everything#4915 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/pr-status-label.mjs:107` — Add a table-driven test over derivePrStatusLabel that sets a historical durable marker (stand-down, rearm) and then adds each transient state (review owed, CI owed, new head). Each must move the label off the stand-down state. A lens question on review: does a state derived from permanent history shadow live state?
2. `we:scripts/conveyor/review-status-tag.mjs:258` — Add an integration-style test that drives tagReviewStatus (or runReviewTick) for a non-WE repo with a red non-fallback required check and asserts `status:ci-red`. Better, resolve the required set inside the writer from the repo slug, as the other callers of required-status-checks do.
3. `we:scripts/conveyor/pr-status-label.mjs:66` — Export an operator or trusted-human predicate next to isTrustedMarkerAuthor and add a lint or check:standards rule that flags ad-hoc login regexes in conveyor modules. Add a test where an untrusted author's reply leaves the stood-down state unchanged.
4. `we:scripts/conveyor/pr-status-label.mjs` — Add a deterministic regression test covering stand-down, human reply, completed repair, and subsequent active review, asserting that the current review state supersedes the historical stand-down.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4915@557a9bccb7925eb1ce65da8de84e2a4efe56abca

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
