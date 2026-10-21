---
bornAs: xf2axvt
kind: story
size: 2
status: open
scope: ["we:scripts/operations/review-job.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5482 (head 9ed64952d)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5482 (reviewed head `9ed64952d86eee7ca6f10fb1b13b58e5fa037f31`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/review-job.mjs:648` — (edge-case, degraded) A disabled red team still blocks enqueue while added seats run.
   - Scenario: Set WE_REVIEW_RED_TEAM=off, leave extra seats enabled, and accept a non-card-only head without an existing red-team result. runReviewJob publishes queued because the runRedTeam hook exists, before executing the added seats. An isolated probe through readDrainRedTeamEvidence returned scheduled:true and queued:true; redTeamEnqueueHold returned 'post-accept red team has no recorded result on the live head' despite the kill switch. Enqueue remains blocked throughout the added-seat run, potentially until its timeout. Only afterward does the real runRedTeam hook return disabled and release the hold.
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
