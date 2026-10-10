---
kind: story
size: 3
status: open
scope: ["we:.github/workflows/review-gate.yml", "we:.github/workflows/soak-replay-gate.yml", "we:.github/workflows/merge-gate.yml", "we:scripts/lib/merge-gate-ci.mjs", "we:scripts/merge-gate-check.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Fail closed on a missing script after bootstrap in review-gate and soak-replay-gate, tie the policy skip to the event, add timeouts

PR 4708 self-review: the permanent fail-open bootstrap (script absent on main reports clear) was fixed only in we:.github/workflows/merge-gate.yml; the same pattern remains in we:.github/workflows/review-gate.yml and we:.github/workflows/soak-replay-gate.yml. Also: we:scripts/lib/merge-gate-ci.mjs lets a drain-direct gatePlacement skip gates on a merge_group run (force the queue strategy on merge_group), the gh and git calls in we:scripts/merge-gate-check.mjs have no timeout, soak-replay-gate has no timeout-minutes, and the dispatch sha inputs are not validated as 40-hex.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/merge-gate-ci.test.mjs` includes workflow-shell tests (like the merge-gate bootstrap ones) showing review-gate and soak-replay-gate exit 1 when their script is missing but their own workflow file is on main, a merge_group run ignores a drain-direct skip, and a non-hex dispatch sha is refused; it fails before this item and passes after.

## Non-goals

- [N1] Does not change which gates exist or the merge-gate verdict rules; only the missing-script, event-policy, timeout and input-validation edges.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — dispatch sha inputs are validated as 40 hex characters before reaching git.
2. **Truncated reads** — n/a: no new reads.
3. **Shared state files** — n/a: no state files.
4. **Fail closed** — a missing script after bootstrap exits 1; a settings error on merge_group holds.
5. **Identity scoping** — n/a: no identity involved.
6. **State over time** — the bootstrap clear applies only while main has neither the script nor its workflow.
7. **Who wrote it** — n/a: workflow and script authorship is not consulted.
