---
kind: story
size: 5
status: open
scope: ["we:scripts/operations/pr-sweep-core.mjs", "we:scripts/conveyor/review-referral-hold.mjs", "we:scripts/lib/round-judge.mjs", "we:scripts/conveyor/pr-stall-sweep.mjs", "we:scripts/conveyor/pr-stall-classify.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# The stall sweep gives the round judge a verdict only when detectRoundCap agrees with the sweep's own hold pre…

Flow-sim gap R6a-G3, class K13 (precondition mismatch fails closed to the operator). Failing input: PR whose newest trusted 'review paused:' comment is the SHORT notice, i.e. no 'Waiting on your ruling' text (posted whenever rulingNeeded() returns nothing, and always for the persistence-exhausted notice), OR a PR with a red-team gate round-cap record for the live head AND an open referral hold. deriveWaitingOn returns 'ruling… Cited: we:scripts/operations/pr-sweep-core.mjs:77-94, we:scripts/conveyor/review-referral-hold.mjs:845-851, we:scripts/lib/round-judge.mjs:152-153, we:scripts/conveyor/pr-stall-sweep.mjs:258-259, we:scripts/conveyor/pr-stall-classify.mjs:242. Soak-break sketch: Fixture: PR thread with a trusted 'review paused: 2 referrals need a ruling; it resumes on a new push, a ruling, or a send-back\n<!-- review-referral-hold: abc12345 -->' comment (no findings block), plus review referral records, files known. Action: runStallS…

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
