---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/__tests__/reconcile-advisory-head-move.test.mjs", "we:scripts/conveyor/soak/breaks/advisory-rerun-head-move.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Harden mechanical-tip advisory detection

PR #7263's 2026-11-21 security review identified cost-only advisory churn: a writer can put any `Conveyor-<Name>:` line in a commit body, or forge a recognized merge/drain headline, to request an advisory on each new head. This does not grant acceptance or clear `review:human`; the setting defaults to off.

## Acceptance

- Replace the broad trailer-name match with the known trailer names emitted by mechanical producers; unknown names such as `Conveyor-X:` cannot establish mechanical provenance.
- Require trustworthy provenance for author-controlled headline shapes, or retain the ordinary no-rerun fallback when provenance is unavailable. Document the producer metadata used and its trust limits.
- Preserve legitimate main merges, update-branch moves, drain bookkeeping, and conveyor recovery commits when their provenance is established. Keep exact-head deduplication and all existing review gates.

## Test and proof plan

Add named cases for forged bodies and headlines, unknown and known trailer names, missing provenance, and genuine mechanical producers. Exercise both newest-first and oldest-first commit lists. Verify the spoof test fails when broad trailer acceptance is restored. Replay genuine and forged tips in the existing advisory head-move soak scenario.

Review prevention key: web-everything/web-everything#7263@b680c2923:security
