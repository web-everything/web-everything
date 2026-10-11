---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/pr-status-label.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#4915 (head 557a9bccb)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#4915 (reviewed head `557a9bccb7925eb1ce65da8de84e2a4efe56abca`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/pr-status-label.mjs:62` — (failing-input, degraded) A successful CI rerun does not restore readiness when the earlier failed run remains in the rollup.
   - Scenario: Give an accepted PR a statusCheckRollup containing an earlier COMPLETED/FAILURE test run followed by its COMPLETED/SUCCESS rerun, with the other required checks successful and no ci:failed label. The probe returned ci-red, while the existing reduceCheckState returned green for the same input. requiredCiRed scans every historical entry instead of collapsing to the latest run per check name. It should return ready-to-merge after the successful rerun.
   - Claude's re-check: requiredCiRed uses checks.some over every rollup entry with no latest-per-name collapse, so an earlier COMPLETED/FAILURE 'test' entry still yields ci-red after a SUCCESS rerun.
2. `we:scripts/conveyor/pr-status-label.mjs:101` — (edge-case, degraded) Historical answered stand-downs override a subsequent active review.
   - Scenario: A fixer stands down, chalbert posts a valid structured answer, the repair completes and pushes a new head, and another review starts. Supply review:pending, green CI, reviewStatus:{role:'review',state:'reviewing'}, and rows:[{kind:'review'}], retaining the historical comments. The probe returned answered-waiting-fixer although latestUnresolvedStandDown returned null. The unconditional historical stand-down branch prevents reaching the active-review branch. It should return awaiting-review once the answered repair has progressed to review.
   - Claude's re-check: Once standDownComments(comments) is non-empty, derive returns answered-waiting-fixer or stood-down before it reaches the awaiting-review branches. Nothing in the diff ties the stand-down to the current head or to being unresolved, so a stale one overrides an active review.
3. `we:scripts/conveyor/pr-status-label.mjs:87` — (failing-input, degraded) The production label writer uses WE's required checks for every repository.
   - Scenario: Call tagReviewStatus for plateauapp/plateau-app with review:accepted, test SUCCESS, e2e FAILURE, no ci:failed label, no live agent and empty planRows. Plateau's declared required checks are test and e2e. The injected-provider probe recorded a status:ready-to-merge write; deriving with Plateau's requiredChecks correctly returned ci-red. tagReviewStatus never supplies requiredChecks, so the new check always defaults to WE's list, which excludes e2e. The writer must receive the repository's effective required-check list.
   - Claude's re-check: requiredChecks is a new parameter of derivePrStatusLabel, defaulting to FALLBACK_REQUIRED_STATUS_CHECKS. The tagReviewStatus changes add no requiredChecks option, so a call that predates the parameter can't pass one. Every repo is therefore judged by the default list. The claim that Plateau also requires e2e comes from code outside the diff.

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
