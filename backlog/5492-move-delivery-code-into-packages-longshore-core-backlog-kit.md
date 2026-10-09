---
bornAs: xuxad3w
kind: story
size: 8
parent: "5488"
status: open
blockedBy: ["5489", "5485", "5487", "5483", "5491"]
scope: ["we:packages/longshore/**", "we:scripts/conveyor/**", "we:scripts/operations/**", "we:scripts/readiness/**", "we:scripts/backlog/**", "we:scripts/backlog.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Move delivery code into packages/longshore (core, backlog, kit) inside the WE monorepo, with shims

Mechanical move of the Longshore-bound code into packages/longshore/{core,backlog,kit} per ruling S2 (one repo, several packages), keeping forwarding shims at every path a plist, a sibling repo or the drain shell still uses. No new repo yet.

## Acceptance

- [A1] **Executable** — every daemon restarted on the new layout runs a full pass, and a journal diff of pass decisions against the day before is empty.
- [A2] Soak suite and `npm run check:standards` are green; every old path a plist, sibling repo or the drain shell uses still resolves through a shim.
- [A3] Daemons find code through coreRoot pointed at `packages/longshore`.

## Non-goals

- [N1] Creating the Longshore repo (the mirror slice does that).
- [N2] Removing the shims (they stay until the flip).
