---
kind: task
status: open
dateOpened: "2026-11-12"
tags: []
related: ["6736"]
---

# Parked: ready-to-merge restore on re-accept (branch lane/ready-label-restore-on-accept) - two audit findings and a design question

Parked, not a PR. Branch `lane/ready-label-restore-on-accept` (tip 80cbbb2e61) adds `we:scripts/conveyor/ready-label-restore.mjs`, wired into the review-hold sweep, to re-add `ready-to-merge` on a re-accepted, red-team-clear, CI-green PR. The live case (#6736, #6381) resolved without it: the drain's existing ci-lifecycle labelling added the label, and the gap was CI timing plus the review:human re-park. Revive only if a real stuck PR shows a missing restorer.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/conveyor/__tests__/ready-label-restore.test.mjs` passes once the two findings below are fixed and a canonical audit says NOT WEAKENED.

## Non-goals

- [N1] n/a: parked; no work is requested until a real stuck PR shows the gap.

## Edge cases this change must handle

1. **Untrusted text** — n/a: reads labels and events only.
2. **Truncated reads** — capped (>=100) rollups refuse; an unreadable or incomplete label timeline refuses.
3. **Shared state files** — n/a.
4. **Fail closed** — missing state, draft, hold labels, red CI, unreadable events: no restore.
5. **Identity scoping** — n/a.
6. **State over time** — finding 2 below.
7. **Who wrote it** — n/a.

## Open canonical-audit findings (last audit, WEAKENED, verbatim)

1. `we:scripts/conveyor/ready-label-restore.mjs:61` — No removal history grants restoration, even when ready-to-merge was never applied. This overrides deliberate omission (including pr-land --no-label) and admits accepted, clear, green PRs into the drain without proving restoration was authorized.
2. `we:scripts/conveyor/ready-label-restore.mjs:97` — The final guard refreshes PR state but not label history. A concurrent ready-to-merge addition/removal after the timeline read leaves the same accepted, clear, unlabelled state and gets overwritten, defeating the deliberate-removal guard.

## Design question (finding 1)

Restore only when a `ready-to-merge` removal exists and a later `review:accepted` add follows it (never-labelled PRs, such as `pr-land --no-label`, are never touched), or keep today's rule (no removal found means restore)? The audit wants the first. Finding 2 fix: read the label events after the last live PR read, at the write boundary.

## Duplicate admission

Case resolved by the drain's existing ci-lifecycle labelling; this branch is parked.
