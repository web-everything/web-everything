---
bornAs: xkiob80
kind: story
size: 3
priority: high
parent: "4075"
status: open
blockedBy: []
scope: ["we:scripts/lib/daemon-self-sync.mjs", "we:scripts/lib/daemon-live-smoke.mjs", "plateau-app:tools/drain-daemon/daemon.mjs"]
dateOpened: "2026-09-24"
tags: []
---

# Clone rebuild, npm ci and the live smoke gate run as jobs, so a self-update never needs a quiet window

Slice of decision 4120 (daemon job model); audit we:reports/2026-09-24-daemon-blocking-antipatterns.md. Filed uncleared until 4120 is ratified; the shape below follows its bold defaults and changes with the ruling. Findings D3, R1. Clone rebuild plus npm ci (drain daemon refreshClone, plateau-app:tools/drain-daemon/daemon.mjs 248-281) and the live smoke gate (we:scripts/lib/daemon-live-smoke.mjs) become jobs: the daemon starts them and keeps ticking on the old code; when the rebuild job and its smoke job both pass, the daemon exits at its next safe point and relaunches on the new code, per #resident-daemon-reload-lifecycle. Running jobs keep their code snapshot. Coordinate with the automatic-rebuild worker, which owns self-sync and live smoke today. Done when: tests; LIVE proof: a self-update with a lockfile change shows no tick gap longer than one interval, from the timestamped tick log.

## Slice 1 — every daemon's clone rebuild + live smoke runs as a job (2026-10-09)

Live harm: the drain merged nothing while its inline `rebuildClone` smoke ran (421 s, 434 s, 1,002 s on
2026-10-09); the review daemon's in-tick smokes cost 344 min the same day. Now the shared `rebuildClone`
delegates to we:scripts/lib/daemon-rebuild/rebuild-job.mjs for a caller whose entries are opted in
(`rebuildAsJob` in we:scripts/lib/daemon-rebuild-settings.json — the drain, review, build-dispatch and fix daemon
entries; env `WE_DAEMON_REBUILD_AS_JOB=0` rolls back). The tick runs an adopt-only prepare (adopts a ready
candidate or a skip-unrelated move, existing rules unchanged) and otherwise queues one `daemon-rebuild` job on the
#4125 runtime; the job runs the unchanged build + live smoke + fallback/hold logic with `--ready-only` and records
a passing build as the ready candidate without moving the clone. The swap is the daemon's next tick (a
self-sync daemon restarts onto the adopted head as before). The rest (the drain's data-clone `npm ci`, the drain
reloading on rebuild-code changes, retiring the x44lnnt builder process) is filed as x0m7a8x.

## Done when

1. **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/daemon-rebuild-job.test.mjs` (fails before:
   the drain-entry rebuild smoked inline; passes after: it queues a job and returns at once).
