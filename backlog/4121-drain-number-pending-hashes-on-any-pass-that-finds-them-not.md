---
bornAs: xb94mt5
kind: story
size: 2
parent: "4075"
status: resolved
dateOpened: "2026-09-24"
dateStarted: "2026-09-25"
dateResolved: "2026-10-09"
graduatedTo: 5bfe2180c
tags: []
scope: ["we:scripts/lane-drain.mjs", "we:scripts/readiness/drain-lock.mjs", "we:scripts/backlog/id.mjs"]
---

# Drain: number pending hashes on any pass that finds them, not only on a pass that merged a WE PR

Audit: we:reports/2026-09-24-daemon-blocking-antipatterns.md (adversarial round). Finding A4 (batch it). JIT numbering in we:scripts/merge-ai-prs.mjs runs only when landedLocal is true (a WE PR merged this pass, around line 4747). A killed pass or a failed push leaves hash files on main un-numbered until the next WE PR happens to land, and the drain daemon's next clone refresh does reset --hard, discarding an unpushed numbering commit (against #resident-daemon-reload-lifecycle clause 4). Fix shape: run the numbering step whenever tracked backlog/x*.md files exist on the refreshed tree, using the cheap check we:scripts/lib/number-pending-hashes-before-push.mjs line 61 already has; resolve-on-land keeps its own landed-this-pass gate. Done when: tests; LIVE proof: a pass with no merges numbers a hash left on main by an earlier failed push (scratch reproduction), log excerpt in the PR.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
