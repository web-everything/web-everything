---
kind: story
size: 3
parent: "4703"
status: open
blockedBy: ["x2fvt08", "xuz8m83"]
scope: ["we:scripts/operations/land-prevention-card.mjs", "we:scripts/operations/__tests__/land-prevention-card.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Route approval-time prevention cards through the card batch, with live before/after proof

Last #4703 MVP slice. Both prevention spawners (we:scripts/review-set-label.mjs and we:scripts/operations/review-loop-cli.mjs) already funnel through we:scripts/lib/prevention-landing-job.mjs into we:scripts/operations/land-prevention-card.mjs, so the switch is made once there. After the card is filed and committed in the lane (we:scripts/operations/land-prevention-card.mjs:347-377), admit it to the prevention batch instead of the per-card verify and open-pr steps (379-407), keyed by the existing approval-prevention idempotency key; then release the lane. Admitted-but-pending returns ok with the batch ref and posts no retraction. A refusal (policy unknown or disabled, lease conflict, ineligible change) falls back to the existing per-card path with the reason logged, so no card is ever lost. Live proof records PR, CI-run and landing counts for an equal window before and after.

## Done when

1. **Executable** — `npx vitest run` over we:scripts/operations/__tests__/land-prevention-card.test.mjs passes (strip the `we:` prefix to execute) with new cases: admission handoff after commit; admitted-pending returns `ok:true` with the batch ref and posts no retraction; each refusal reason falls back to the per-card verify + open-pr path.
2. **Must (refuse on error)** — when admission throws or refuses, the card still lands through the existing per-card path; a card is never left only in a released lane.
3. **Must** — the lane is released after admission, not held across the age window.
4. **Live proof (required)** — with prevention batching enabled on the real daemons: at least 3 approval-time prevention cards land in one merged `lane/card-batch-prevention-*` PR with one commit each, and none of them also lands as a single `lane/*-prevention-card` PR. Record in this card: the batch PR number, its member cards, its CI runs, and before/after counts over equal windows of merged single-card prevention PRs, PR CI runs and main-push CI runs.
5. **Executable** — `npm run check:standards` green.

## Build checklist

- [ ] Change only the verify + open-pr block (we:scripts/operations/land-prevention-card.mjs:379-407) into: admit → on refusal, run the old block unchanged.
- [ ] Pass the approval-prevention idempotency key and source PR/head into admission.
- [ ] Update the file header (it still names only we:scripts/review-set-label.mjs as the spawner; the shared leaf we:scripts/lib/prevention-landing-job.mjs has two callers since #4493).
- [ ] Before/after baseline: 93 of the 200 most recently merged PRs (2026-10-04 02:06Z to 2026-10-06) were single-file prevention-card PRs.
