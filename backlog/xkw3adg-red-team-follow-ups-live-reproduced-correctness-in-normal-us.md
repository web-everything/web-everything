---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/stuck-prs.mjs", "we:scripts/conveyor/pass-daemons/pr-expectation-pass.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7190 (head cbd6c8025)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7190 (reviewed head `cbd6c80250a0427c0b14776cccca6a08826fb39a`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/stuck-prs.mjs:48` — (failing-input, degraded) Canonical WE fix claims are silently excluded from dead-holder detection
   - Scenario: Supply an expired fix claim with meta.repo="we", meta.pr=7 and meta.kind="fix", with no live sessions. collectClaims returns an empty array without warnings. Production fix dispatch passes the canonical repoKey "we" into claim acquisition, which preserves it in metadata. These claims should reach liveness evaluation so a dead holder can produce R-c.
   - Class: live-reproduced (basis: An in-memory call to the production collectClaims export reproduced the empty result using injected claim/session readers. Production dispatch and claim-acquisition code confirm that "we" is the normal stored value.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/conveyor/pass-daemons/pr-expectation-pass.mjs:164` — (edge-case, degraded) Another PR’s red-team verdict satisfies the watched PR’s expectation
   - Scenario: PR 7 receives red-team:pending at 00:00. Its head-check response contains only a completed successful red-team check at 00:02 with the same SHA but external_id="web-everything/web-everything#8". At 01:01, the collector and evaluator report PR 7's red-team-no-verdict expectation as met. PR 7 has received no verdict and should remain missed. The existing red-team reader explicitly enforces this per-PR external_id binding.
   - Class: live-reproduced (basis: Reproduced through the production collector and evaluator with injected GitHub responses. The existing red-team check producer and reader establish that external_id identifies the PR independently of the shared SHA.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
3. `we:scripts/conveyor/pass-daemons/pr-expectation-pass.mjs:166` — (failing-input, degraded) Expected review-gate failures generate false CI-heal alarms
   - Scenario: Return a completed head-bound check named "review-gate", started at 00:01 and concluded failure at 00:02. At 00:30 without a fixer/healer observation, the evaluator reports ci-red-no-heal as missed. This workflow deliberately fails while review:pending, review:changes or review:human holds stand; that is not a CI defect requiring repair. Excluding review-gate from review detection currently sends it into the generic CI branch. Such hold checks should not start CI-heal deadlines.
   - Class: live-reproduced (basis: The production collector generated ci-started and ci-red for the supplied review-gate failure, and the production evaluator returned ci-red-no-heal=missed. The checked-in review-gate workflow confirms deliberate failure is ordinary hold behavior.)
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
