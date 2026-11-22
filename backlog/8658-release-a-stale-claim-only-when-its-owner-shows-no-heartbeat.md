---
bornAs: xbjci0z
kind: task
status: open
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Release a stale claim only when its owner shows no heartbeat or lease activity for 30 min

Fixer gap 3 (#7271): release a stale claim only if the owner has no heartbeat or lease activity for 30 minutes (multi-account safe). Source: build-queue 22:43 ET 2026-11-20.

## Acceptance

- [A1] **Executable** — Planned `releases claim only after both activity signals expire` in `we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs`: Use a controlled clock at just below, exactly at and beyond 30 minutes; assert release only when both heartbeat and lease activity are stale.
- [A2] **Executable** — Planned `retains claim with either recent activity signal` in `we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs`: Parameterize recent owner heartbeat and recent lease activity independently; assert neither claim is released.

Run `npm run test:unit -- <test-files>` through the host heavy-run queue using the repository-relative paths after the `we:` prefixes above. These cases are planned; this card does not claim they already pass.

## Non-goals

- [N1] No age-only claim release.

## Edge cases this change must handle

1. **Untrusted text** — Claim fields remain data.
2. **Truncated reads** — Unreadable activity evidence retains the claim.
3. **Shared state files** — Recheck claim ownership before release.
4. **Fail closed** — Missing activity evidence holds release with an operator-visible reason.
5. **Identity scoping** — Scope activity to the owner across accounts.
6. **State over time** — Test just below, at and above 30 minutes and renewed activity.
7. **Who wrote it** — Use owner activity evidence, not a claimant assertion.

## Duplicate admission

new card from build-queue CARD line
