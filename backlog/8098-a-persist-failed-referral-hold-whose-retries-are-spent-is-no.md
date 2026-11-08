---
bornAs: x86hjr2
kind: story
size: 3
status: open
related: ["6260"]
scope: ["we:scripts/conveyor/review-referral-hold.mjs", "we:scripts/operations/pr-sweep-core.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# A persist-failed referral hold whose retries are spent is not released by the operator's own ruling, while th…

Flow-sim gap R6a-G2, class K10 (hold without a settler). Failing input: Review run R parked with persistenceFailed=true on head H; the 15/30/60 retry budget is spent, so the hold notice reads 'review paused: N referrals could not be persisted and the automatic retries are spent; it resumes on a new push or an operator reply'. The operator then rules every finding not-real or card with record-referr… Cited: we:scripts/conveyor/review-referral-hold.mjs:218-222, we:scripts/conveyor/review-referral-hold.mjs:329-331, we:scripts/conveyor/review-referral-hold.mjs:338-340, we:scripts/conveyor/review-referral-hold.mjs:341, we:scripts/conveyor/review-referral-hold.mjs:348-354. Soak-break sketch: Fixture: parked run with persistenceFailed:true, persistRetries >= 3, plus the hold notice; thread has a valid operator ruling comment on the run's head covering all pending keys, authored by the operator login. Action: decideReferralHold / findResumableParke…

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
