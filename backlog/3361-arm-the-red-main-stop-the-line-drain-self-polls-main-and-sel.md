---
bornAs: xu9c4q4
kind: story
size: 5
status: open
blockedBy: ["5001"]
scope: ["we:scripts/readiness/red-main-remediation.mjs"]
dateOpened: "2026-08-26"
tags: []
---

# Arm the red-main stop-the-line — drain self-polls main and self-freezes, revert-to-green stays drain-owned

DEFERRED BY THE OPERATOR 2026-08-26 — recover manually until it hurts. #2681 built the dispatch-freeze and revert-authority remediation, and `we:scripts/merge-ai-prs.mjs` already refuses to land while the freeze marker is present. But nothing ever writes that marker, so the lever is dormant. Arming it means the drain polls main's CI status at the top of its sweep and freezes itself.

**Un-deferred 2026-10-03 (operator).** Approved ~14:45 ET, verbatim *"Ok for all"*, in answer to the orchestrator's recommendation to re-open this card. Revert must only target a culprit that the blame step identified, so this card is `blockedBy` 5001 (main-red blame and bisection, `bornAs` `5001`).

## Why the design is already constrained

Two facts settle most of the shape:

- The marker is a gitignored `.conveyor/` local file, so CI on another machine cannot arm it. The drain has to
  poll main's own CI status at the top of its sweep and self-freeze.
- Auto-revert must run THROUGH the drain. A workflow pushing a revert straight to main would be a second
  writer, forbidden by the `#event-driven-land-is-wake-only` anchor in
  `we:docs/agent/platform-decisions.md` clause 1. The pure `decidePostLand` core already names the revert
  target.

## Why this became necessary

#2681 assumed the case could never fire, because the test-selection shrink is opt-in and off. Turning
`strict` off (ruled in #3347) re-opens post-land reds from a different direction, which is what eventually
makes arming this worth doing.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
