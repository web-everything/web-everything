---
bornAs: xh6ij2v
kind: story
size: 1
status: active
scaffoldedBy: "main-red-soak"
dateScaffolded: "2026-10-08"
scope: ["we:scripts/conveyor/soak/breaks/build-dispatch-orphan-adopt.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Red main: build-dispatch-orphan-adopt soak reads the real backlog for delivery evidence

Since 5422 (settle builds by real outcome) adoptOrphanedBuildClaims reads real delivery evidence (gh PRs + origin/main card status). The soak scenario uses real card numbers (#4382, #4468) that are resolved on main, so they now settle as card-resolved instead of release and main CI soak-shard fails. Make the scenario inject its own delivery evidence (none for the release shapes) and add a delivered-card shape asserting settled.

## Done when

1. **Executable** — `npm run test:soak -- we:scripts/conveyor/soak/breaks/build-dispatch-orphan-adopt.soak.test.mjs` fails on main at 36fcd6abe (#4382/#4468 `settled` by real merged PRs) and passes after; the soak-shard job on main goes green.

## Edge cases this change must handle

1. **Untrusted text** — n/a: test fixture only, no external input.
2. **Truncated reads** — n/a: the scenario no longer reads gh or origin/main for delivery evidence.
3. **Shared state files** — the failed-start backoff and lane-lease release are faked, so the soak never writes the host's real queue or lane pool.
