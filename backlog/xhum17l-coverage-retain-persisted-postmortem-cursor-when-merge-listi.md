---
kind: story
size: 1
parent: "xvi6k7s"
status: open
scope: ["we:scripts/conveyor/pass-daemons/pr-postmortem-pass.mjs", "we:scripts/operations/__tests__/coroner-pr-postmortem.test.mjs"]
dateOpened: "2026-10-21"
tags: []
---

# Coverage: retain persisted postmortem cursor when merge listing fails

PR #5502 advisory (2026-10-21) explicitly deferred this later-round suggestion to a card: add a named test for persisted cursor retention when merge listing fails. Do not change the PR runtime behavior for this suggestion.

## Design
Add a named integration test in we:scripts/operations/__tests__/coroner-pr-postmortem.test.mjs exercising runPostmortemPass from we:scripts/conveyor/pass-daemons/pr-postmortem-pass.mjs with a pre-existing cursor and a failing merge-listing dependency.

## Acceptance
The pass rejects, the persisted cursor, receipts, failures and quarantines stay unchanged, and collection/publication do not run. A subsequent successful retry uses the retained discovery window. Include listing rejection, invalid listing and saturated page-cap variants through the real listMergedSince wiring where applicable.

## Test plan
Use isolated state directories and injected GitHub reads. Run npm run test:unit -- coroner-pr-postmortem. Demonstrate the test detects premature cursor advancement without changing production guards by hand.

## Edge cases this change must handle
Untrusted text: injected fixture data only. Truncated reads: capped listing refuses without cursor movement. Shared state: isolated roots and real persistence. Fail closed: reject listing errors. Identity scoping: one explicit repository. State over time: successful retry retains discovery window. Who wrote it: no trust changes.

## Non-goals
No runtime change or review-label change is authorized by filing this follow-up.
