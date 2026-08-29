---
bornAs: xl1ru2l
kind: task
status: active
dateOpened: "2026-08-05"
dateStarted: "2026-08-29"
tags: []
scope: ["we:scripts/lib/invariant-catalogue.json"]
---

# The invariant catalogue still claims the lane guard exempts agent memory — the guard denies it

[`we:scripts/lib/invariant-catalogue.json`](scripts/lib/invariant-catalogue.json) states that the `PreToolUse(Edit|Write)` lane guard denies primary-checkout edits "except the agent-memory tree, which is exempt". That exemption was **removed on 2026-07-09**: [`we:scripts/guard-lane.mjs`](scripts/guard-lane.mjs) denies a primary agent-memory edit like any other tracked file, and says so in its own denial message. The catalogue is a cite-able file, so it keeps telling the next session the opposite of what the guard does.

## The divergence (verified 2026-08-05)

| Source | What it says |
|---|---|
| [`we:scripts/lib/invariant-catalogue.json`](scripts/lib/invariant-catalogue.json), invariant `guard-lane.denies-primary-tree-edit` | "…except the agent-memory tree, which is exempt…"; `howChecked` names an `inAgentMemory` term in the classification |
| [`we:scripts/guard-lane.mjs`](scripts/guard-lane.mjs) | "Agent memory is NO LONGER exempt (2026-07-09)"; the returned denial reads "Agent memory is git-tracked project content — it is **NOT** exempt (2026-07-09)" |
| `status` in the catalogue entry | `enforced` — i.e. the entry asserts the stale statement is actively upheld |

The code has no `inAgentMemory` early-return at all any more; `isMemory` survives only to pick which *wording* the denial message uses.

## Why it matters

The catalogue exists to be the citable record of what the guards actually do — an agent reading it to decide whether a primary-tree memory edit is sanctioned gets a green light the guard will refuse, and a red-team reading it scores an invariant as covered when its statement is false. Surfaced while resolving #2909; filed rather than left as a prose bullet in that item's closing note, since #2909 resolving would have carried the obligation out of the backlog with it.

## Done when

- The `guard-lane.denies-primary-tree-edit` entry's `statement` and `howChecked` match [`we:scripts/guard-lane.mjs`](scripts/guard-lane.mjs) — no exemption, and the classification term named is one the code actually has.
- A check makes this class **script-detectable** rather than relying on a reader noticing: at minimum a test that fails when the catalogue asserts an exemption the guard's own classification does not implement.
- The rest of the catalogue is swept once for the same staleness class (an entry whose `status: enforced` outlived the code it describes).

## Progress

- **Done:** Rewrote the `guard-lane.denies-primary-tree-edit` `statement`/`howChecked` in `we:scripts/lib/invariant-catalogue.json` to match `we:scripts/guard-lane.mjs`'s actual `laneGuardDecision()` — no exemption, `isMemory` (not the removed `inAgentMemory`) named as the real classification term.
- **Done:** Added `we:scripts/lib/__tests__/invariant-catalogue-guard-lane-sync.test.mjs` — asserts the guard actually denies a primary agent-memory edit, that the statement never re-claims an "except…exempt" carve-out, and that every classification term `howChecked` names is one `we:scripts/guard-lane.mjs` actually declares. Verified it fails on the original stale wording before confirming it passes on the fix.
- **Done:** Swept every `howChecked` entry in the catalogue for a referenced file/function that no longer exists in the repo (script-checked, not just read). Found and fixed one more: `guard-bash.denies-direct-main-push`'s `howChecked` pointed at `we:scripts/guard-bash.test.mjs`, which moved to `we:scripts/__tests__/guard-bash.test.mjs`. No other entry's referenced path or named function was missing.
