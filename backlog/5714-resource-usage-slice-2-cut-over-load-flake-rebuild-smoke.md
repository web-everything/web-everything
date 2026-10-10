---
bornAs: x9xkupj
kind: story
size: 5
priority: high
parent: "5712"
status: resolved
blockedBy: ["5713"]
scope: ["we:scripts/conveyor/load-flake-reverify.mjs", "we:scripts/conveyor/__tests__/load-flake-reverify.test.mjs", "we:scripts/lib/daemon-live-smoke.mjs", "we:scripts/lib/__tests__/daemon-live-smoke.test.mjs", "we:scripts/lib/resource-policy.mjs"]
dateOpened: "2026-10-09"
dateResolved: "2026-10-09"
tags: []
---

# Resource service slice 2: cut load-flake re-arm and daemon rebuild smoke over to admit()

After slice 1's shadow log shows the new verdict is right, the load-flake reverify pass (we:scripts/conveyor/load-flake-reverify.mjs planLoadFlakeReverify 'host-load' deferral, today load average per core vs maxLoadPerCore) first gains its shadow call (its file was held by PR #4700 during slice 1), then decides through admit({kind:'load-flake-rearm'}); the rebuild smoke's hostLooksBusy and load-scaled budgets (we:scripts/lib/daemon-live-smoke.mjs) and the load-shaped env hold (we:scripts/lib/daemon-rebuild/smoke.mjs, held by PR #4712 during slice 1) decide through admit({kind:'rebuild-smoke'}). Register the sampler supervisor as a managed daemon in we:skills-src/conveyor/daemon-manifest.mjs (held by PR #4691 during slice 1). Old load-average branches stay only as the logged comparison until slice 4. Done when: tests pin the cut-over; LIVE proof — at load average above 9 with CPU idle above the policy floor, the reverify pass and a rebuild smoke proceed, with the log line naming the admit verdict.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- <tests>` on we:scripts/conveyor/__tests__/load-flake-reverify.test.mjs and we:scripts/lib/__tests__/daemon-live-smoke.test.mjs: the `resource-admission cut-over (x9xkupj)` and `resource shadow observations` blocks fail before this item (18 red) and pass after.
- [A2] The reverify pass decides quiet from `admit({kind:'load-flake-rearm'})` (via `shadowAdmission`, which also logs the old load verdict); a `host-load` deferral names the admission verdict, reason and snapshot age.
- [A3] The rebuild smoke's budgets and `hostLooksBusy` decide from `admit({kind:'rebuild-smoke'})`: admitted ⇒ unscaled budgets / not busy; wait or hold ⇒ max factor / busy. The smoke result carries `admission`.
- [A4] Thresholds stay in the one policy block (we:scripts/lib/resource-policy.mjs), calibrated from 1261 snapshots: rebuild-smoke CPU idle ≥ 5%, load-flake-rearm ≥ 20%, disk busy never gated (100% busy in every sample).

## Non-goals

- [N1] Registering the sampler in we:skills-src/conveyor/daemon-manifest.mjs: both manifest files are held by PR #4691 (review:changes/human), so it is split out as xcnbnk2.
- [N2] we:scripts/lib/daemon-rebuild/smoke.mjs and we:scripts/lib/daemon-rebuild/smoke-classify/load-shaped.mjs: on inspection they read no load average (they classify failed rows by timeout/lock-contention signature), so there is no load gate there to cut over.
- [N3] Deleting the old load-average code: it stays as the logged comparison and as the fallback for callers that pass no decision, until slice 4 (xmd6ngm).

## Edge cases this change must handle

1. **Untrusted text** — the admission reason is library-built text (numbers + fixed words), posted in the redispatch comment; no branch-authored text is added.
2. **Truncated reads** — a torn/unparseable snapshot reads as missing: unknown ⇒ hold for these heavy kinds (library behaviour).
3. **Shared state files** — only reads the sampler snapshot; shadow rows go through the library's locked append.
4. **Fail closed** — stale or missing snapshot ⇒ hold (re-arm waits; smoke scales budgets to max and treats the host as busy). An admission probe that throws or returns nothing falls back to the legacy load rule, never to admit.
5. **Identity scoping** — n/a: host-wide resource signal, no per-user state.
6. **State over time** — snapshot freshness is enforced by the library (`freshUntil`); one decision is taken per reverify run / per smoke run.
7. **Who wrote it** — the snapshot is written only by the sampler job under the operator's user in the coordination root.
