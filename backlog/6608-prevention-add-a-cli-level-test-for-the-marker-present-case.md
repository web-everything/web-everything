---
bornAs: xq6jr4z
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/review-set-label.mjs", "we:scripts/lib/drain-merge-strategy.mjs", "we:scripts/operations/red-team-gate-apply.mjs", "we:scripts/lib/drain-red-team-evidence.mjs", "we:scripts/__tests__/review-set-label.test.mjs", "we:scripts/lib/__tests__/drain-merge-strategy.test.mjs", "we:scripts/operations/__tests__/red-team-gate-apply.test.mjs", "we:scripts/lib/__tests__/drain-red-team-evidence.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Add a CLI-level test for the marker-present case (refuses) and the marker-absent case (strips rea… (from web-everything/web-everything#5482 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/review-set-label.mjs:474` — Add a CLI-level test for the marker-present case (refuses) and the marker-absent case (strips ready-to-merge). Make `acceptanceStillCoversHead` required rather than defaulted.
2. `we:scripts/lib/drain-merge-strategy.mjs:333` — Add a test: a held or send-back pending head past `redTeamPendingMaxMin` but within `retryAt` makes no new comment-thread read.
3. `we:scripts/operations/red-team-gate-apply.mjs:124` — Have the gate sync read `readDrainRedTeamEvidence` (as review-job does), or skip the sync when the apply status is 'no-red-team-on-head'. Add a test for that status.
4. `we:scripts/lib/drain-red-team-evidence.mjs:66` — Give `recordRedTeamStatus` a distinct result for skips that mean red team owed but not run (cap, no seat), and add a test that such a skip keeps the head held or logs the never-scheduled note. A lint that rejects tests asserting a null hold on a skip without a named reason would catch the class.
5. `we:scripts/review-set-label.mjs:1401` — Add `runReviewLabelCli` tests for a missing-only re-arm with: (a) a trusted marker for the live head, which keeps readiness; (b) an untrusted marker, which strips it; (c) a marker for a different head, which strips it. A pure function with a fail-open-looking default should require the argument explicitly (throw if undefined).

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5482@62170e06d4eaf5b91ab89b9b458f688d1bf6df9a

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
