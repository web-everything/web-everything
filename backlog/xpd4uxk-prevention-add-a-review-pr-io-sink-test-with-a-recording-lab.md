---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/review-pr-io.mjs", "we:scripts/operations/__tests__/review-pr-io.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a review-pr-io sink test with a recording labelProvider that asserts editComment receives { r… (from web-everything/web-everything#7407 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/review-pr-io.mjs:1302` — Add a review-pr-io sink test with a recording labelProvider that asserts editComment receives `{ repo: <pr repo> }` for an existing-referral update. Optionally add a standards rule requiring a wiring test whenever a provider method gains a required option.
2. `we:scripts/operations/review-pr-io.mjs:1302` — Add a review-pr-io test that uses a recording labelProvider and asserts the third argument to editComment equals `{ repo: read.repo }`. A broader option is a lint or contract test that every editComment call site passes a repo option.
3. `we:scripts/operations/review-pr-io.mjs:1302` — Add the named production-sink regression test to the required test gate, asserting GH_REPO and the subsequently observed referral snapshot; record a named live acceptance check for frontierui#55.
4. `we:scripts/operations/review-pr-io.mjs:1302` — Add a deterministic integration test through createReviewPrSinks that asserts cross-repository routing and persisted snapshot readback; separately name and record the live acceptance check. The PR description already identifies the caller-test gap as carded.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7407@012257eb2703284d50553138c594446f03bec2e9

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
