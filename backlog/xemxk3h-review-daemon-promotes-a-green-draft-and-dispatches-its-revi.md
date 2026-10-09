---
kind: story
size: 3
priority: high
status: open
scope: ["we:skills-src/conveyor/review-daemon.mjs", "we:scripts/conveyor/draft-promotion-rule.mjs", "we:scripts/conveyor/draft-promotion-loop.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Review daemon promotes a green draft and dispatches its review in one pass

Draft-first adds two daemon hops before the first review. Green draft to promoted (fix-daemon tick): median 6.4 min, p90 36, 610 PR-min over 51 PRs; promoted to review dispatched: median 5.3, p90 40.8, 2,300 PR-min over 113 PRs (2026-10-07 19:00 to 2026-10-09 15:42 ET). Card 5561 fixes the fix-tick starvation tail, not the hop itself. Fix idea: when the review daemon sees a draft whose required checks are all green (it already logs 'owed a promote-draft', and pr-events wakes it on check_suite.completed), it promotes the draft itself and dispatches the review in the same pass; the fix daemon keeps promotion only as a fallback. Evidence: review-daemon.log 'owed a promote-draft' (180 lines), fix-dispatch-daemon.log (wev-fix-daemon) 'promoted ... to ready for review'; worst #4567/#4563/#4535 42 min. Found by coroner-4 (held item 187).

## Acceptance

- [A1] **Executable** — a unit test drives one review-daemon pass over a draft PR whose required checks are all green: before, the pass logs `owed a promote-draft` and dispatches nothing; after, the same pass promotes the draft and dispatches its review.
- [A2] A draft with any required check pending or red is not promoted by the review daemon (test).
- [A3] The fix daemon's promotion still runs as a fallback, and a PR the review daemon already promoted is not promoted twice (test).
- [A4] Live proof: after landing, the promoted → review-dispatched hop on the next green drafts drops from the 5.3 min median toward one pass (coroner or review-daemon.log before/after).

## Non-goals

- [N1] Does not change the fix-tick starvation tail (card 5561 owns that).
- [N2] Does not change when a PR is opened as a draft, or the review itself.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — PR title/body are never used to decide promotion; only the required-check states from gh.
2. **Truncated reads** — a partial or failed check-state read counts as not green; no promotion.
3. **Shared state files** — both daemons may promote; promotion is idempotent (already-ready PR is a no-op) and the review dispatch keeps its existing one-per-head guard.
4. **Fail closed** — if the promote call fails, no review is dispatched this pass and the fix-daemon fallback stays in place.
5. **Identity scoping** — only PRs on our repos that the conveyor already owns (same filter as the existing promote-draft rule).
6. **State over time** — a new push after green re-runs checks; promotion uses the current head's checks only.
7. **Who wrote it** — n/a: same draft PRs the fix daemon promotes today; no new author class.
