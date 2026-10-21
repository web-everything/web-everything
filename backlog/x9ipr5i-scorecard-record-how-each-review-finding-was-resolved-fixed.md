---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/record-referral-ruling.mjs", "we:scripts/conveyor/run-scorecards.mjs"]
dateOpened: "2026-10-21"
tags: []
---

# Scorecard: record how each review finding was resolved (fixed / dismissed-not-real / carded / ignored)

Today a finding that mandatory seats did not corroborate is not necessarily wrong, and dismissals are not counted. Add a resolution field to scorecard rows, written by the ruling tools (`record-referral-ruling`, the red-team ruling CLI) and by fix-evidence when a finding is fixed. Values: fixed / dismissed-not-real / carded / ignored. Backfill is not required. This enables precision per lens.

## Acceptance

- [A1] **Executable** — tests show each ruling tool and fix-evidence writes the resolution value onto the matching scorecard finding, and the scorecard summary reports per-lens counts by resolution.
- [A2] **Executable** — a finding with no ruling reads as `ignored` only after its PR lands, never earlier.

## Non-goals

- [N1] No backfill of old rows.
- [N2] Does not change any seat's gating; that is decision xviqirz.

## Edge cases this change must handle

1. **Untrusted text** — the resolution is an enum; free text from rulings is rejected.
2. **Truncated reads** — a partial scorecard read must not be written back (no data loss).
3. **Shared state files** — the scorecard file is shared by several writers; use the existing atomic/locked write path.
4. **Fail closed** — an unknown resolution value is refused.
5. **Identity scoping** — match findings by run id + lens + finding id, never by title alone.
6. **State over time** — a later ruling may overwrite `ignored`; a ruling never silently downgrades `fixed`.
7. **Who wrote it** — record which tool wrote the resolution.
