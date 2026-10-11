---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/takeover-budget.mjs", "we:scripts/conveyor/takeover-review.mjs", "we:scripts/conveyor/mechanical-round-cap.mjs", "we:scripts/conveyor/__tests__/takeover-budget.test.mjs", "we:scripts/conveyor/__tests__/fix-round-history.test.mjs", "we:scripts/conveyor/fix-resume.mjs", "we:scripts/conveyor/__tests__/fix-resume.test.mjs", "we:scripts/conveyor/__tests__/takeover-review.test.mjs", "we:scripts/conveyor/__tests__/mechanical-round-cap.test.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Prevention — Expose one 'concluded verdict' predicate and add a lint or test that the takeover modules call is… (from web-everything/web-everything#4792 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/takeover-budget.mjs:112` — Expose one 'concluded verdict' predicate and add a lint or test that the takeover modules call isConcludedVerdict, never isReviewVerdictComment directly.
2. `we:scripts/conveyor/takeover-review.mjs:80` — For each boundary comparison named in a card's edge-case list, require a test pair (before and after the boundary). A review lens can check this.
3. `we:scripts/conveyor/mechanical-round-cap.mjs:90` — Anchor the match to the banner line (or use a structured marker such as an HTML comment) and add a test where a real review bounce quotes the phrase in a finding. A lint for body.includes(<phrase>) on trusted-comment classifiers would catch the class.
4. `we:scripts/conveyor/__tests__/takeover-budget.test.mjs:280` — Require an adversarial-ordering test for any 'last X wins' parser comment in review-lens standards, or add a table-driven forge test next to isPausedReview.
5. `we:scripts/conveyor/__tests__/fix-round-history.test.mjs` — Extend the existing CI test with an untrusted review containing a unique finding and assert that the rendered history excludes it.
6. `we:scripts/conveyor/fix-resume.mjs` — Add a deterministic expired-lease regression test asserting that the resume prompt requires acquisition, and require lease liveness before returning held: 'own'.
7. `we:scripts/conveyor/takeover-budget.mjs` — Add a deterministic table-driven test covering every supported impact and asserting monotonic severity weights and refusal when severity worsens.
8. `we:scripts/conveyor/__tests__/fix-resume.test.mjs` — Gate the reader with an injected-filesystem unit test asserting the maximum read length, tail offset, and exclusion of the torn first record.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4792@1faeb70c499abdf497222338ab8c456d253997a2

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
