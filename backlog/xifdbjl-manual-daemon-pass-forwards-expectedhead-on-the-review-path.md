---
kind: story
size: 1
status: active
scaffoldedBy: "fix-6676"
dateScaffolded: "2026-11-11"
scope: ["we:scripts/operations/manual-daemon-pass-io.mjs", "we:scripts/operations/__tests__/manual-daemon-pass-io.test.mjs"]
dateOpened: "2026-11-11"
tags: []
---

# Manual daemon pass forwards expectedHead on the review path

dispatchManualPass validates and prechecks expectedHead, then calls dispatchReviewByMode(options) without it on the review path, so the review job is not head-pinned after the precheck (the red-team path already forwards it to dispatchReviewJob). PR 6676 works around this in the live-owner watch with a pinning loader. Forward expectedHead to dispatchReviewByMode, refuse it in session mode (dispatchReview has no head pin), and add a test that a job-side head change after the precheck refuses launch. Found by the PR 6676 review (fix-6676).

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

## Duplicate admission

Matches are resolved review-daemon/smoke/rating cards and an open required-checks read-volume card; none covers the manual launcher dropping expectedHead.
