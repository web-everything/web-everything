---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/urgent-verify.mjs", "we:scripts/operations/__tests__/urgent-verify.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — Add a branch-coverage threshold for we:scripts/operations/urgent-verify.mjs, or a review-lens che… (from web-everything/web-everything#7589 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/urgent-verify.mjs:330` — Add a branch-coverage threshold for we:scripts/operations/urgent-verify.mjs, or a review-lens checklist item: every early `return` in a ledger-mutating function needs a test that asserts no append.
2. `we:scripts/operations/urgent-verify.mjs:401` — Parameterize the deferral test over the step that defers, and have it assert the guard check and fallback wording for a non-first step.
3. `we:scripts/operations/urgent-verify.mjs:337` — Add a deterministic test named 'malformed ledger rejects prior green evidence before and after deferral' in we:scripts/operations/__tests__/urgent-verify-deferral.test.mjs, asserting urgentMarker rejects a valid green record followed by malformed content both before and after deferral.
4. `we:scripts/operations/urgent-verify.mjs:337` — Add a deterministic regression test containing a signed prior green plus malformed ledger content, and assert that deferral leaves that evidence unusable by urgentMarker.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7589@715000b5182123f663f865297766463fdd027ece

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
