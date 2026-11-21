---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/enqueue-on-event.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7146 (head 952123975)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7146 (reviewed head `95212397533c8061a614906875f2f525734c8281`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/enqueue-on-event.mjs:667` — (edge-case, degraded) Red-team result comments never reach the new memo invalidation path
   - Scenario: Remember a red-team-pending decline under main CI run 100. Publish a same-head red-team result comment without changing labels or checks, then advance main CI to 101. The production drain-role feed filters out issue_comment events and returns marked: [], so notePoll cannot invalidate the memo. The changed predicate still suppresses the retry; the parent predicate permits it. Comment-based clearance can consequently wait until memo expiry instead of being rechecked at the next catch-up. The drain feed must deliver these invalidations before main-CI invalidation is removed.
   - Class: live-reproduced (basis: A read-only probe using the actual createFeedConsumer consumed an issue_comment.created event with kind=redteam and returned marked: []. Evaluating the actual unchangedDecline function returned true after main changed to 101; restoring its parent condition returned false.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/enqueue-on-event.mjs:1332` — (edge-case, degraded) A later feed-page failure discards already-consumed invalidation marks
   - Scenario: With a remembered decline, successfully consume a pull_request_review.submitted event on page one, then fail page two. pollOnce returns ok:false with the numbered PR mark and an advanced cursor. notePoll ignores the entire result. The next successful poll starts after that event and returns no marks, permanently losing its memo invalidation. Even a changed main CI run now leaves the decline suppressed until expiry. Process successfully consumed marks despite a later page failure, or retain them for subsequent invalidation.
   - Class: live-reproduced (basis: The actual feed consumer returned ok:false, cursor:11 and the review mark after an injected second-page failure. Its following poll returned marked:[]. The notePoll guard rejects the first result, and the actual changed decline predicate continued suppressing the unchanged PR across main CI churn.)
   - Also class: correctness-in-normal-use
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
