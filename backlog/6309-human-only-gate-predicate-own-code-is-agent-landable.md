---
bornAs: x19ebm9
kind: story
size: 3
status: open
priority: high
scaffoldedBy: "fix-5549"
dateScaffolded: "2026-10-18"
scope: ["we:scripts/lib/merge-queue-enqueue.mjs", "we:scripts/lib/drain-workflow-edit-hold.mjs", "we:scripts/lib/__tests__/drain-workflow-edit-hold.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# human-only gate predicate: its own code is agent-landable under the narrow review preset

Found while fixing PR #5549 (operator ruling 2026-10-18 on red-team break #1). The drain's human-only boundary is the `GATE_PATH_PREFIXES` list and the `workflowEditHold` predicate in we:scripts/lib/merge-queue-enqueue.mjs, applied by we:scripts/lib/drain-workflow-edit-hold.mjs.

**The gap.** A read-only probe on 2026-10-18 shows `workflowEditHold` returns `hold: false` for a PR that changes only we:scripts/lib/merge-queue-enqueue.mjs, only we:scripts/lib/drain-workflow-edit-hold.mjs or only we:scripts/lib/__tests__/drain-workflow-edit-hold.test.mjs. The `narrow` `humanReviewSurfaces` preset in force also leaves out the `gate-self` category. So an agent PR that removes an entry from the list, or makes the predicate skip it, can land through agent review. Every path the list protects loses its protection with it: the workflow files today, and the operator-override trust root and enforcing modules of we:backlog/6266-we-operator-override-slice-1-host-wide-store-and-operator-on.md once slice 1 lands.

**The decision to make while building.** The predicate must hold its own list, its own code and its call site, without making every unrelated edit to the enqueue module human-only. One shape: move the list, `normalizeGatePath` and `workflowEditHold` into a small dedicated module that the list itself names, re-exported from the enqueue module for existing callers.

## Acceptance

- [A1] **Executable** — `npm run test:unit --` (vitest) on we:scripts/lib/__tests__/drain-workflow-edit-hold.test.mjs. Named test: `the human-only predicate holds its own list, predicate and call site` — a separate agent PR that changes only the module holding the list and predicate, or only the drain call site, or only that test file, is held (`hold: true`, `humanOnly: true`); an unrelated edit elsewhere in the enqueue module is not held.

## Non-goals

- [N1] Does not change which paths the list protects beyond adding its own files.
- [N2] Does not change the `humanReviewSurfaces` preset.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: paths still go through `normalizeGatePath` (NFKC, case, separators) unchanged.
2. **Truncated reads** — n/a: the existing fail-closed `unreadable` hold for an incomplete change list is unchanged.
3. **Shared state files** — n/a: a pure path predicate, no state.
4. **Fail closed** — a rename away from a protected path is held, through the existing `previous_filename` check.
5. **Identity scoping** — n/a: the hold applies to every PR author alike.
6. **State over time** — the new entries hold before and after the move, so no commit in between leaves the predicate unprotected.
7. **Who wrote it** — n/a: no new record.
