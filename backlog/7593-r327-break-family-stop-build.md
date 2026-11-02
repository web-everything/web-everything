---
bornAs: xccdjyl
kind: story
size: 5
parent: "7592"
status: open
scaffoldedBy: "r327-cards-ab-lane-26-fb353f00"
dateScaffolded: "2026-11-01"
blockedBy: ["7592"]
scope: ["we:scripts/lib/red-team-gate.mjs", "we:scripts/lib/__tests__/break-family-stop.test.mjs"]
dateOpened: "2026-11-01"
tags: []
---

# Build the break-family stop in the review daemon

Build child of 7592. Policy, forks and defaults live there; this card holds mechanics only and is dispatched after the parent is ratified.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/lib/__tests__/break-family-stop.test.mjs` passes, including the #5964/#6033 replay fixture and a control history that must not stop.
- [A2] **Observable** — review daemon dry-run on the real #6033 comments prints a `break-family-stop` decision (count and round); the pre-change dry-run prints none. Before/after output in the PR.

## Non-goals

- [N1] No change to severity classes or to the existing round-cap and grant logic beyond reading the new stop.

## Edge cases this change must handle

1. **Untrusted text** — per the parent card's threat model; this build reads structured fields only.
2. **Truncated reads** — unreadable input fails toward the hold or refusal.
3. **Shared state files** — n/a: derives from PR comments or card files on main; writes none.
4. **Fail closed** — per the parent card, edge case 4.
5. **Identity scoping** — per the parent card's Fork 2 or Fork 3 defaults.
6. **State over time** — per the parent card; staleness uses the existing shared rule.
7. **Who wrote it** — applies to agent and operator authors alike.

## Mechanics

- Add a pure family counter beside `parseRedTeamComment` in we:scripts/lib/red-team-gate.mjs: key = category normalized to a closed vocabulary plus file path without line, over confirmed `broken`/`degraded` findings, lineage-wide, per the parent defaults.
- Setting `redTeam.breakFamilyStop.threshold` (default 3) and `mode` of `report-only | enforce` (start `report-only`, flip after one clean week).
- At the threshold in enforce mode the round-grant step refuses further fix rounds and routes the PR to the `/prepare` hold ("needs-design") through the existing hold-routing path. An `extend-rounds` grant does not lift it. A linked, scope-covering card stamped after the stop (commit order), meeting the same width limit as `7591` (scope depth and entry count), opens a new window; a second stop goes to the operator.
- Freeze the #5964/#6033 advisory results as a scrubbed fixture with each PR's own round labels; exclude C10 to C12 (not advisory-sourced). Record actual per-round counts in the PR; if they disagree with #7582, report it and do not tune the key.
- Lineage is detected mechanically and also by a declared link (split from, supersedes, shared parent card).
- Report an advisory when a lineage keeps producing unconfirmed or unverifiable findings.
- Prototype-first: register the branch through the overlay loader; the daemon rebuild smoke is the gate. Codex read-only audit must say NOT WEAKENED.
