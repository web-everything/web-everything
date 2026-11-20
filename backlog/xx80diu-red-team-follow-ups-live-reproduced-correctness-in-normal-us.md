---
kind: story
size: 2
status: open
scope: ["we:scripts/readiness/test-selection.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7212 (head 0094007e0)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7212 (reviewed head `0094007e0e97751428227700bb4865ad525f51e2`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/readiness/test-selection.mjs:618` — (failing-input, degraded) Omitting assertionResults lets contradictory failure evidence pass validation and record a clean sample.
   - Scenario: With WE_DIFF_TEST_SELECTION=1 and changedFiles=['we:docs/a.md'], run --measure using full report {"numTotalTests":1,"numFailedTests":1,"success":true,"testResults":[{"name":"we:a.test.mjs","status":"passed"}]} and selected report {"testResults":[]}. Validation accepts the contradictory full report because missing assertionResults disables counter checks. Measurement exits 0 and records hadReport:true, failedCount:0, falseGreen:false. It should reject the contradictory evidence, record falseGreen:null/status:'report-invalid', and exit 1.
   - Class: live-reproduced (basis: Executed the actual validator and CLI module in a VM with filesystem/git calls stubbed for read-only operation. Observed acceptance and the clean shrink-mode measurement; adding assertionResults:[] made the same counters fail validation.)
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
