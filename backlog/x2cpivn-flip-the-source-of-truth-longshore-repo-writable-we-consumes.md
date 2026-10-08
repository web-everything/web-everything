---
kind: story
size: 5
parent: "xpd5nhi"
status: open
blockedBy: ["xh1pxjn", "xs1r68q", "xgc6mv8"]
scope: ["we:package.json", "we:package-lock.json", "we:packages/longshore/**", "we:.github/workflows/ci.yml"]
dateOpened: "2026-10-08"
tags: []
---

# Flip the source of truth: Longshore repo writable, WE consumes @longshore as a pinned npm package

Ruling S4: after the switch-over, the Longshore repo becomes the writable home; WE consumes @longshore packages as a pinned npm dependency (linked locally in dev) for the delivery rule pack, packages/longshore is deleted from WE, and delivery tests leave WE CI. Longshore gets its own test check so the drain can land its PRs.

## Acceptance

- [A1] **Executable** — WE CI runs no delivery test suites, and its run time drop is recorded in the PR.
- [A2] WE consumes @longshore at a pinned version, linked locally in dev (ruling S4); the delivery rule pack still runs on WE.
- [A3] A WE PR and a Longshore PR both land through the drain; Longshore has its own `test` check.
- [A4] `packages/longshore` is deleted from WE; the old-path shims are removed.

## Non-goals

- [N1] Public visibility (separate slice, ruling S6).
