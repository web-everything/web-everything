---
bornAs: xup1jgh
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/review-referral-hold.mjs", "we:skills-src/conveyor/review-daemon.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# One corrupt or vanishing review-pr run record blocks reconcile for every repo and both daemons

Flow-sim gap A-C4, class K4 (poison record halts a whole pass). Failing input: labels: 'any PRs with review:pending' files: '<workspace>/.operations/runs/review-pr-<uuid>.json that fails parseRunRecord (record written by newer lane code than the daemon clone validates; truncated by disk-full; hand-edit) OR a file deleted by pruneTerminalRuns (RS:251-285, another daemon) between readdir and stat' any tick … Cited: we:scripts/conveyor/reconcile-pass.mjs:1745, we:scripts/conveyor/review-referral-hold.mjs:677, we:scripts/conveyor/review-referral-hold.mjs:169, we:scripts/conveyor/review-referral-hold.mjs:176, we:scripts/conveyor/review-referral-hold.mjs:185. Soak-break sketch: stuck: all owed reviews (all constellation repos) stop being planned until the file is removed by hand; log shows only 'reconcile failed (non-fatal)'. Violates 'failure improves the product': needs a tolerant per-record read in readReviewRunEvidence.

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
