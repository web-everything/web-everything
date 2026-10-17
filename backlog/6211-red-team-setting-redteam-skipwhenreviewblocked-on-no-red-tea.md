---
bornAs: xx3ffrw
kind: story
size: 3
status: open
scope: ["we:scripts/operations/review-job.mjs", "we:scripts/lib/review-speculative-red-team.mjs", "we:scripts/settings/review.json"]
dateOpened: "2026-10-17"
tags: []
---

# Red team setting redTeam.skipWhenReviewBlocked=on: no red team while the review is blocked on infra

Build after #5482 and #5465 land (they hold we:scripts/operations/review-job.mjs). 733 of 1,878 speculative starts (39%) were discarded because the review was blocked on infra (Claude weekly limit etc.); 710 of them on 16 Oct, PRs 5426 to 5430 re-reviewed in a loop, each retry starting and killing a codex red team; about 584 codex minutes. Spec: redTeam.skipWhenReviewBlocked = on. Do not start (or start speculatively) a red team while the review for that PR is blocked on infra: a usage/weekly limit, an outage, the queue cap, a blocked job state. Read the existing block signals; add no new detection. Operator 2026-10-17: Ok. Never weaken a hold. Tests first, run red, one per setting. A cascade setting with its source logged.

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
