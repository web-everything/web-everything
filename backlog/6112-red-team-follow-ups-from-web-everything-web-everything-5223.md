---
bornAs: x6g2eyv
kind: story
size: 2
status: open
scope: ["we:scripts/lib/native-github-review.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5223 (head ae2a7cab8)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5223 (reviewed head `ae2a7cab8015c4dc1162cc029d942f58df92c9af`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/native-github-review.mjs:474` — (edge-case, degraded) Queued cleanup erases a missing-approval mismatch
   - Scenario: Accept under a worker token while an old bot change request exists and the reviewer token is unavailable. The mirror queues dismissal and records native=APPROVE, agree=no. A later reviewer run on another PR drains that dismissal and records the original PR/head/accepted key with native=none, outcome=dismissed, agree=n/a. summarizeReadiness replaces the original mismatch with this cleanup record, although no approval was posted. A probe confirmed mismatches changed from 1 to 0 with zero approvals for that PR. Cleanup completion should not clear the missing-approval mismatch.
   - Claude's re-check: An accept under a worker token yields outcome=skipped, agree=no, reason=token-is-not-reviewer, which is not a neutral skip, so it counts as a mismatch. The later drain records the same key (repo#pr(at)head12:accepted) with outcome=dismissed, native=none, agree=n/a. summarizeReadiness keeps the latest line per key, so the mismatch disappears although no approval was posted.
2. `we:scripts/lib/native-github-review.mjs:564` — (failing-input, degraded) Read failures during clearing verdicts disappear from readiness
   - Scenario: Rearm a PR carrying the bot's CHANGES_REQUESTED review, and make the reviews GET fail with HTTP 503. The mirror performs no dismissal and returns reviews-unreadable, but logs agree=n/a because rearm has no native event and the early return omits dismissal=failed. The stale request remains standing. Combining this actual result with 50 successful records produced mirrored=50, mismatches=0, ready=true. An unreadable required cleanup should count as an unresolved mismatch.
   - Claude's re-check: For rearm, event is null and the identity check passes. When readReviews throws, the code returns finish('skipped','reviews-unreadable') with no dismissal field. formatComparisonLine then gives agree=n/a, because event is null. summarizeReadiness counts only agree=no as a mismatch, so the unread cleanup is invisible and ready can still be true.

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
