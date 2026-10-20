---
bornAs: xr4vgb1
kind: story
size: 2
status: open
scope: ["we:scripts/lib/ledger-promotion-readiness.mjs", "we:scripts/lib/ledger-readiness-daily.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5195 (head 20579a255)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5195 (reviewed head `20579a25576d5e07af60023a4a27033ab9c1e241`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/ledger-promotion-readiness.mjs:95` — (failing-input, degraded) Replay projects agreement for accepted PRs whose missing ledger evidence the writer cannot supply.
   - Scenario: Verified with a Node probe: use an empty ledger and a merge verdict with a full head SHA and reviewGate.acceptedMerge:true, as produced by the review:accepted gate branch. planDrainLedgerFacts emits no rows: this branch is not review-exempt, and restamping requires an existing clearing verdict. shadowRow therefore remains disagree with no-ledger-row. Nevertheless, projectDrainFactsRow changes that exact row to status:'agree'. Replay should retain this disagreement unless evidence establishes that the writer can resolve it. The current projection overstates projected agreement; live readiness r
   - Claude's re-check: planRows emits an exempt row only when reviewGate.reviewExempt is true. It restamps only when folded.current exists. An accepted merge on an empty ledger therefore writes nothing. projectDrainFactsRow still turns a lone 'no-ledger-row' disagreement into 'agree', so replay overstates agreement.
2. `we:scripts/lib/ledger-readiness-daily.mjs:89` — (edge-case, degraded) An overnight quiet toggle consumes the following evening's nightly check at midnight.
   - Scenario: Verified by calling dailyCheckDue sequentially with the default 22:00 America/New_York schedule. Turn quiet mode on October 13 at 22:00 ET with until October 14 at 07:00 ET. The first check runs for October 13. At October 14 00:00 ET, the unchanged active toggle triggers another check for October 14. Once that day's line is recorded, October 14 at 22:00 ET returns 'already ran for 2026-10-14', despite the toggle having expired that morning. A toggle carried across midnight should not count as newly turned on and suppress the next evening's scheduled measurement.
   - Claude's re-check: dailyCheckDue only checks that the toggle is active and that lastDay differs from today. A toggle carried past midnight therefore counts as 'turned on' and runs the check at 00:00 on the new day. That records the day, so the 22:00 scheduled check returns 'already ran'.

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
