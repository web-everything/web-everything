---
bornAs: xii6vye
kind: epic
parent: "3383"
status: open
scope: ["we:scripts/conveyor/", "we:skills-src/conveyor/", "we:scripts/lib/", "we:scripts/lane-pool.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/lib/poc-branches.json"]
dateOpened: "2026-09-23"
tags: []
---

# Graduate lane/daemon-poc to main

Tracks the ongoing graduation of the lane/daemon-poc POC branch (we:scripts/lib/poc-branches.json) to main. Operator ruling 2026-09-23 (verbatim, in conversation): 'I'd thought we would first fix the deamon in protoytpe to go quick and then graduat to main once perfect' -- daemons (review/merge/drain) run from this POC branch for fast iteration; each fix also graduates to main through the normal PR. See we:docs/agent/platform-decisions.md#poc-branch-declared-delivery-mode and #poc-branch-mechanical-sync for the machinery this reuses. A companion decision card records the statute-tension this departure raises (clause 4(a): daemons tracking a POC branch instead of main) for ratification.

## Done when

1. **Executable** — `git rev-list --left-right --count origin/main...origin/lane/daemon-poc` reports `0` on
   the right (lane-branch-ahead) side: every commit unique to `origin/lane/daemon-poc` has landed on `main`
   through its own small reviewed PR, or this item is resolved with an explicit note naming which remaining
   commits were deliberately dropped/superseded and why.
2. The statute-tension decision this POC's daemon-tracking departure raises (a sibling `kind: decision` card,
   filed alongside this one) is ratified — clause 4(a) of
   `we:docs/agent/platform-decisions.md#poc-branch-declared-delivery-mode` amended or the departure reverted —
   before `lane/daemon-poc` is treated as a durable steady state rather than a time-boxed prototype.

## Slice procedure

Same procedure `we:docs/agent/platform-decisions.md#poc-branch-mechanical-sync` point 4 already establishes
for `lane/mechanical-dispatcher`'s own graduation (see `backlog/3443-*.md`), applied to this branch: a child
of this item is a graduation slice, landable on `main` any time whatever the branch's sync state, exempt from
the `branch-drift-blocked` hold, each slice its own small reviewed PR through the normal lane pipeline — never
a bulk merge of the branch and never a direct push to `main`.

## Progress

- 2026-09-23: Branch opened (`origin/lane/daemon-poc` = `origin/main` at `75298c517`), registered in
  `we:scripts/lib/poc-branches.json` with this item as `graduationItem`, per the operator's ruling this item's
  digest quotes verbatim.
- 2026-09-23 (evening): ruling #3681 superseded this branch as a daemon steady state. Daemons now run `main` plus
  live overlays
  ([#resident-daemon-reload-lifecycle](../docs/agent/platform-decisions.md#resident-daemon-reload-lifecycle)
  clause 5). Done-when 2 is met by that ruling (clause 4(a) amended, for overlays rather than POC tracking). The
  wind-down is 4042: the pass-daemon commit graduates via 3998, the POC-mode commit `69b2ec0cc` is dropped
  as superseded by 4002, then the registry entry is removed and this epic resolves.
