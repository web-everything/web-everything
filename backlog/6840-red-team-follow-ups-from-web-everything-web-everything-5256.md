---
bornAs: xmal967
kind: story
size: 2
status: open
scope: ["we:scripts/lib/enqueue-on-event.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5256 (head 0ef4690bf)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5256 (reviewed head `0ef4690bfadbdb1d4d9098d9c0ac7f736081ecb6`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/enqueue-on-event.mjs:562` — (edge-case, degraded) Stopping catch-up deletes fresh event work for PRs with both origins.
   - Scenario: Plan catch-up for #42, #43 and #44. While #42 runs, deliver check_suite.completed=success(at)12 for #43 and allow its debounce to elapse. #43 now has causes ['catch-up','check_suite.completed=success'] and catchUp=true. When #42 returns a batching-deferred enqueue outcome, line 562 deletes #43 along with catch-up-only work. The probe observed drains=[42] and pending=[], losing the fresh event. Subsequent ticks cannot process that event; #43 must await another event or catch-up round. Preserve its event causes and remove only its catch-up origin, as honourSetting already does when disabling catch-
   - Claude's re-check: On a catch-up PR's batching deferral, the new loop deletes every pending entry with 'entry.catchUp'. It does not check whether the entry also has event causes, so a mixed-origin PR such as #43 loses its fresh event work. The test only covers an event-only PR (#99).
2. `we:scripts/lib/enqueue-on-event.mjs:545` — (edge-case, degraded) Confirmed merges are reported as failed queue admissions.
   - Scenario: A PR merges out-of-band during its fast drain. The existing recordAlreadyMerged path produces toMerge=[{num:42}], merged=[{num:42}], failed=[], with no enqueueOutcomes. summarizeFastDrain calls this enqueued; the new membership check returns ok=true,inQueue=false because the PR has merged. The probe produced verified=false, 'NOT enqueued ... retrying on the next catch-up', and misses=[\[42,1]\], despite confirmed success. The same false failure occurs when a successful queue admission merges before the membership read, even with an AddedToMergeQueueEvent present. Honor the merged result and quer
   - Claude's re-check: The already-merged path pushes no enqueueOutcomes, so summarizeFastDrain falls back to the legacy toMerge branch and reports 'enqueued'. The new code then reads membership, and a merged PR returns inQueue=false. That sets verified=false, logs 'NOT enqueued ... retrying' and counts a miss, though the PR merged.

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
