---
kind: story
size: 3
parent: "x8juafk"
status: open
blockedBy: ["xjddimd"]
relatedTo: ["5510", "5118"]
scope: ["we:scripts/conveyor/build-dispatch-policy.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/lib/delivery-priority-settings.json"]
dateOpened: "2026-10-08"
tags: [conveyor, priority, incident]
---

# Incident mode: pause P3/P4 builds and land only P0 or proven-green PRs while main is red

Slice S3b of epic x8juafk (ruling Q5, all but the merge-gate exemption). While a main-red episode is open: no new P3/P4 build or prepare starts; the drain lands only P0 and PRs proven green on the red main (#5118's halt design). Review and fix of P1-P3 continue (they do not touch main), behind P0 in every line.

The builder pause itself is being built in the main-red-owner work (card 5510, PR #4527). This slice makes that pause class-aware (P0-P2 builds still start) and adds the drain's class gate. It does not rebuild the pause or the main-red signal.

## Acceptance

- [A1] **Executable** — replay fixtures: with an open episode, a P3 build is refused `incident-mode`, a P0/P1/P2 build is admitted; the drain lands a P0 and a proven-green P3 and holds an unproven P3.
- [A2] With no open episode, or setting `incidentMode: off`, build and drain behave exactly as today (fixture).
- [A3] Each refusal names the open episode and the item's class.

## Non-goals

- [N1] The P0 exemption from owed-ci-rerun / main-still-red (xy828sf, ships last).
- [N2] Detecting red main or naming its owner (5510).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the gate reads the episode record and the item's class only.
2. **Truncated reads** — an unreadable episode record counts as "no episode" for the freeze (today's behaviour), and the drain's existing red-main halt (#5118) still applies.
3. **Shared state files** — the episode record is read-only here.
4. **Fail closed** — an invalid setting gives today's behaviour.
5. **Identity scoping** — the episode is per repo; a red main in one repo never freezes another repo's builds.
6. **State over time** — the record's expiry ends the freeze if the health watch stops.
7. **Who wrote it** — only the health watch's episode record opens incident mode.
