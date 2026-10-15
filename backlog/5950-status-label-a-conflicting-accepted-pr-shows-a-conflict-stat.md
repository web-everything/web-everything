---
bornAs: xdohuyg
kind: story
size: 1
status: open
scope: ["we:scripts/conveyor/pr-status-label.mjs", "we:scripts/conveyor/__tests__/pr-status-label.test.mjs"]
dateOpened: "2026-10-12"
preparedDate: "2026-10-14"
preparedAgainstSha: "6742d1202f2de0350e0a5a6978cebaa385be8b43"
tags: []
---

# Status label: a conflicting accepted PR shows a conflict state, not ready-to-merge

A PR with a known merge conflict must not be described as ready to merge just because review is accepted. Add a conflict status before the accepted-readiness branch while preserving existing higher-priority operator and CI states.

## Progress

- Original scope omitted the existing matching test; corrected scope includes it. Original incident #4792 described red CI plus conflict showing ready; that is historical evidence, not a current live observation.
- Current code already checks required red CI before acceptance in we:scripts/conveyor/pr-status-label.mjs:120–124. The remaining defect is a known conflict with no higher-priority CI/operator state: the accepted branch returns readiness without checking either mergeability field.
- The status vocabulary and descriptions are declared in we:scripts/conveyor/pr-status-label.mjs:18–42; add the new state there so existing label planning recognizes and removes it normally. Current readiness/CI tests live in we:scripts/conveyor/__tests__/pr-status-label.test.mjs:63 and :163.
- Size remains 1: approximately 8 source lines and 45 test lines across two files.

## Design

Add `conflict` to the state vocabulary with a description explaining that merge conflicts need repair. After existing operator and red-CI checks, but before accepted/red-team readiness, treat either `mergeable === 'CONFLICTING'` or `mergeStateStatus === 'DIRTY'` as conflict. If a fix/CI-heal worker is active, report `fixing`; otherwise report `conflict`. Preserve operator attention and red-CI precedence. Unknown or missing mergeability is not positive conflict evidence and keeps existing behavior.

## MVP

Register the new label state, insert the conflict branch, and test both classification and the existing add/remove label plan. Keep the normal tagger as the only label writer.

## Test plan

Extend we:scripts/conveyor/__tests__/pr-status-label.test.mjs with accepted+CONFLICTING and accepted+DIRTY, each without the other field; explicit ready-to-merge labels must not hide either conflict. Cover active fixer, active review/red-team, operator attention, red required CI, unknown/missing mergeability, and contradictory fields (either explicit conflict wins). Assert the transition removes `status:ready-to-merge`, adds `status:conflict`, and reverses after conflict clearance; the new label is recognized by the regex and has a description. Run the suite through the host heavy-admission queue.

## Proof plan

Replay an accepted green-CI snapshot with DIRTY through the real derivation and label planner: before, readiness; after, conflict with one add and one remove. Repeat with CONFLICTING only, then clear the conflict and observe readiness returning. Use injected snapshots without live label mutations; red CI must still report its existing higher-priority state.

## Acceptance

Neither explicit conflict representation can yield ready-to-merge. Existing operator, CI and running-repair states retain priority, and the managed status label remains singular across transitions.

## Non-goals

No merge permission change, conflict repair dispatch, polling/schema expansion, or reordering of operator/CI policy.

## Edge cases

Missing snapshot fields are not invented conflicts. Stale managed labels are removed by the existing planner. Explicit contradictory conflict evidence prevents readiness. No untrusted text parsing, new shared file, endpoint or authorship decision is introduced.

## Follow-ups

If a future snapshot producer omits both mergeability fields, fix that producer separately with evidence; this item handles the existing two supported representations.
