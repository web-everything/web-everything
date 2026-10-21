---
bornAs: xqeymmg
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/lib/operator-send-backs.mjs", "we:scripts/conveyor/__tests__/reconcile-round-grants.test.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs", "we:scripts/lib/__tests__/operator-send-backs.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Add a lifecycle replay test (send-back → fix-end → re-arm → review of the new head) for every mec… (from web-everything/web-everything#5373 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-core.mjs:3557` — Add a lifecycle replay test (send-back → fix-end → re-arm → review of the new head) for every mechanism that buys a past-cap fix round. Ideally a shared helper that asserts both the fix and the review side of each such grant.
2. `we:scripts/lib/operator-send-backs.mjs:61` — Add a test for different head + explicit 'never addressed' naming, with an explicit statement of which rule wins. Treat edits to an existing test's fixture data in a behaviour PR as a review-lens flag.
3. `we:scripts/lib/operator-send-backs.mjs:73` — Add a deterministic unit test asserting that a head-less send-back is not cleared by prose-only evidence. Alternatively, require a trusted fix-end or fix-round marker between the send-back and the evidence for any prose-coverage resolution.
4. `we:scripts/conveyor/__tests__/reconcile-round-grants.test.mjs:22` — Add the named regression test to the automated suite, asserting the refusal, current attempts, and historical cap with a nonzero competing durable count.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5373@74f8b9bf913ef19ecb52fbc237c903355e270ee9

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
