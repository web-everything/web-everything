---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/review-timing.mjs", "we:scripts/lib/review-ci-gate-io.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5465 (head f1c3a9b94)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5465 (reviewed head `f1c3a9b94218a082125f313d73da12a93877776f`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/review-timing.mjs:102` — (edge-case, degraded) Same-head CI reruns reset the supposedly bounded joined-fix deadline
   - Scenario: A required test fails at 10:00 while a reviewer remains live. Rerun that check on the same head every ten minutes and let each rerun fail. fixReadiness collapses the runs before selecting timestamps, replacing firstReadyAt with each latest failure. A Node probe through fixReadiness and joinedFixDecision still returned wait at 11:00, with the deadline moved to 11:15. In reconcile this also keeps the live-reviewer hold intact. The deadline should remain 10:15 for the uninterrupted failure episode.
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/review-ci-gate-io.mjs:62` — (failing-input, degraded) Required merge-gate failures evade discovery and publication cancellation
   - Scenario: Configure merge-gate as required. On one pinned head, make standards and test-shard (1) successful and merge-gate fail for a genuine failure, with no review-hold excusal. readReviewCiGate calls ciRedOnHead without the required set; that fallback excludes merge-gate, so readRequired is never called. A Node probe returned allowed:true and requiredChecks:[], and reviewMustVoid returned false even with cancelOnCiRed:true. Passing the actual required set to reviewStartGate correctly returns ci-red. Discover requirements for this failure so review start is blocked and enabled publication cancellatio
   - Claude's re-check: demonstrated break

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
