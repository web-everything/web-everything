---
kind: story
size: 5
parent: "3383"
status: open
scope: ["we:skills-src/conveyor/", "we:scripts/conveyor/"]
dateOpened: "2026-09-22"
tags: []
---

# Build a shared daemon-freshness pass that self-restarts a stale daemon in a safe window

Discussed 2026-09-22, after repeatedly having to manually fetch/merge a dedicated daemon clone (e.g. wev-review-daemon) and launchctl kickstart it by hand every time a daemon-code fix merged, to actually apply it. Today nothing watches for 'origin/main just advanced' on any dedicated daemon checkout -- a merged fix sits inert until a human (or this session) notices and manually restarts the affected process. Decision made: one shared pass (mirroring we:scripts/conveyor/lane-pool-health-watch.mjs's own pattern -- a small script wired into we:skills-src/conveyor/daemon-manifest.mjs's manifest, ticking on its own interval via we:skills-src/conveyor/pass-daemon.mjs), not per-daemon self-update logic duplicated into every one of the ~18 eventual daemon files. For each dedicated daemon checkout: fetch + fast-forward-only if clean (never touch a dirty/diverged checkout -- same conservative posture as everything else in this epic); if it actually advanced, signal that daemon's own process to restart -- but ONLY in a safe window, not mid-tick. A daemon self-restarting while mid-dispatch (an in-flight dispatch call, an in-flight git push) risks a half-applied action with no clean recovery, unlike a restart between ticks where nothing is in flight. The safe-window check itself is the real design question this item must resolve (not yet decided): candidates include probing whether the daemon currently has an active child process running (a ps parent-child relationship, similar to we:skills-src/conveyor/review-daemon.mjs's own dispatched-agent tracking), reading a per-daemon 'currently idle vs currently ticking' flag each daemon would need to start publishing, or reusing the lease heartbeat's own timing to infer between-tick idle windows. Every daemon already handles SIGTERM cleanly (releases its lease, exits) -- this pass reuses that existing shutdown path, it does not invent a new one. Explicitly a decision-then-build item, not pure build: the safe-window detection mechanism needs a real design call before implementation, same as #3872 was carved out for credential scoping.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
