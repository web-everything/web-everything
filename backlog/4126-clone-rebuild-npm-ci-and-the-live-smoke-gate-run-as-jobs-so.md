---
bornAs: xkiob80
kind: story
size: 3
priority: high
parent: "4075"
status: open
blockedBy: ["4131"]
scope: ["we:scripts/lib/daemon-self-sync.mjs", "we:scripts/lib/daemon-live-smoke.mjs", "plateau-app:tools/drain-daemon/daemon.mjs"]
dateOpened: "2026-09-24"
tags: []
---

# Clone rebuild, npm ci and the live smoke gate run as jobs, so a self-update never needs a quiet window

Slice of decision 4120 (daemon job model); audit we:reports/2026-09-24-daemon-blocking-antipatterns.md. Filed uncleared until 4120 is ratified; the shape below follows its bold defaults and changes with the ruling. Findings D3, R1. Clone rebuild plus npm ci (drain daemon refreshClone, plateau-app:tools/drain-daemon/daemon.mjs 248-281) and the live smoke gate (we:scripts/lib/daemon-live-smoke.mjs) become jobs: the daemon starts them and keeps ticking on the old code; when the rebuild job and its smoke job both pass, the daemon exits at its next safe point and relaunches on the new code, per #resident-daemon-reload-lifecycle. Running jobs keep their code snapshot. Coordinate with the automatic-rebuild worker, which owns self-sync and live smoke today. Done when: tests; LIVE proof: a self-update with a lockfile change shows no tick gap longer than one interval, from the timestamped tick log.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
