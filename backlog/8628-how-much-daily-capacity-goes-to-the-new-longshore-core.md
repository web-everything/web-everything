---
bornAs: x8fzhda
kind: decision
parent: "5488"
status: open
dateOpened: "2026-11-20"
tags: [decision-filing, plateau-app]
relatedTo: ["5488"]
preparedDate: "2026-11-20"
---

# How much daily capacity goes to the new Longshore core?

Ask: Default to two Longshore work slots, taking only spare capacity and touching no WE files. The number remains configurable.

## Digest

**No fork: a per-repo lane-ceiling setting, default 2 for Longshore.** Other counts are legitimate configurations. Research grounds the guard rails and initial value; this does not unpause the builder.

## Supported by default

- Generic `delivery.otherRepos` schema `{repo → maxLanes}` defaults unset/0. Only the operator layer names `longshoreai/longshore → 2`; record/apply via `we:record-decision.mjs` and `operator-override-set` (R1040).
- Spare slots only: async fixer → blockers → builder retain priority. Longshore uses slots only when WE is scope-crowded; never pre-empt those roles.
- Shared admission still checks idle CPU/free memory (prep thresholds 15% / 4 GB). Two is a ceiling, not entitlement. Scope briefs must be disjoint; any WE edit counts as WE work.
- Longshore test CI and strict conformity still apply. Measured moved-code debt is tracked rather than blocking the move.
- Orchestrator may reduce to 0 on pressure/stop signals; raising above 2 needs the operator.

Evidence:
- Prep snapshot, 2026-11-20 21:44 ET: CPU 85.5% idle, 27 GB free, load 8.8, 30 open WE PRs against cap 60; Longshore private/empty. These are historical measurements, not current admission evidence.
- `longshore-end-state-2026-11-20` §3(C)/4: two disjoint seed slices, core and sim. Later ports depend on WE tap fixtures and do not create a third independent stream.
- `we:rulings-active.md:203/:208/:296/:299/:301` (R1040/R1045, capacity, priorities, otherRepos).

Skeptic: SURVIVES-WITH-AMENDMENT; generic product key, operator-only value and immediate apply mechanism. Screen: correctly classified as prioritization/configuration, not a standards fork.

## What ratifying unlocks

Up to two disjoint Longshore lanes after #5488 permits seed work, subject to live admission and all shared ceilings. “D5 yes” accepts 2, or the operator supplies another value.

## Trust boundary and threat model

Historical capacity is no launch authorization. Re-evaluate shared admission for each start and preserve declared touch sets; operator values never ship in product defaults.

Full prep (Standards decisions-prep set):

```text
D5-x8fzhda.md
```

Source and proposed artifact filenames (handoff references are by name only):

```text
D5-x8fzhda.md
longshore-end-state-2026-11-20.md
```
