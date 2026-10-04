---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/operations/review-pr-io.mjs", "we:scripts/conveyor/__tests__/review-referral-hold.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# The referral hold must also gate the advisory-fix review branches in reconcile-core

Live 2026-10-04 on PR 3771: the hold from #4918 (we:scripts/conveyor/review-referral-hold.mjs) exists, yet the review daemon re-dispatched a full review on an unchanged head at 03:50 and 04:00. Cause: the two advisory-fix branches in we:scripts/conveyor/reconcile-core.mjs push kind review directly, bypassing the hold that only dispatchReviewRow checks. A parked review posts no fresh advisory note, so the fix-mark stays 'addressed' and the review is owed every tick. Fix: gate both direct pushes on pr.referralHold, refuse review-referrals-pending; skip an identical re-post of a mandatory referral record in we:scripts/operations/review-pr-io.mjs.

## Done when

1. **Executable** — `node we:scripts/conveyor/soak/red-green.mjs --break=review-held-pr-redispatched-by-advisory-fix-branch` exits 0 (red without the fix, green with it).
2. **Must (error)** — a hold that cannot be read still refuses nothing new: the hold is only ever read from the existing run evidence, so a read error leaves today's behaviour.
3. **Must (inputs)** — the same gate covers docs/config/data-only PRs: it keys on the PR's head and thread, never on file kind.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
