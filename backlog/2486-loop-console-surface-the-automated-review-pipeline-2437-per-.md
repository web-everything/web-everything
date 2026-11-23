---
bornAs: xq2inrr
kind: story
size: 3
parent: "2445"
status: open
blockedBy: ["2500"]
dateOpened: "2026-07-14"
tags: []
---

# Loop console: surface the automated review pipeline (#2437) — per-lens verdicts, disposition, rendered comment

The review console today (shipped by the resolved #2470) surfaces only the HUMAN accept/reject step on a parked PR. But the automated review pipeline from #2437 (`review-parked-prs`) already produces a per-PR ledger — `{pr, disposition, verdict, commentBody}`: the per-lens verdicts, a proposed disposition, and a fully rendered comment body — and NONE of it has a UI. Wire that output into the review console: for each parked PR show "panel running on #N", the per-lens verdicts, the proposed disposition, and the rendered comment, not just a bare parked entry. Give the operator the panel's reasoning, not only the label.

## Grounding

#2437 is resolved: the `review-parked-prs` Workflow runs the shared review core over each parked PR and emits the ledger, but its only output today is the label + a posted comment. The operator sees a parked row with no visibility into WHY the panel landed where it did. Surfacing the ledger closes the gap between "a panel ran" and "here is what it found."

## Prerequisite

#2437 is already resolved, so this is READY — no open `blockedBy`. It builds on the review-detail surface from the resolved #2470 (`we:scripts/review-detail.mjs` + the `plateau:tools/dev-panel/drain-daemon.html` review expand); this item adds the automated-panel ledger alongside the existing human-verdict controls. Impl lives in plateau-app; WE holds zero impl (this card is the tracker).

Merged into plan step PD-LIVE (PL-WIP-CLEANUP, 2026-11-22).
