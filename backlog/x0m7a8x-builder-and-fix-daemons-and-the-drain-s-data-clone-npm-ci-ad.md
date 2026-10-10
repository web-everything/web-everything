---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-self-sync.mjs", "we:scripts/lib/daemon-background-build.mjs", "we:scripts/lib/daemon-rebuild-builder.mjs", "plateau-app:tools/drain-daemon/daemon.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Builder and fix daemons and the drain's data-clone npm ci adopt the rebuild job (4126 part 2)

Slice 2 of #4126. Slice 1 (lane/jobmodel-4126) moved the shared clone rebuild + live smoke into a detached durable
job (we:scripts/lib/daemon-rebuild/rebuild-job.mjs on the daemon-jobs runtime) for the drain, review,
build-dispatch and fix daemons: the tick adopts only a smoke-passed ready candidate. Remaining:
(1) the fix daemon still runs the pre-job x44lnnt builder process, which now only launches the rebuild job and
adopts its result — retire the bespoke builder record (we:scripts/lib/daemon-background-build.mjs) once the job
covers its re-clone and swap-spacing rules;
(2) the drain's refreshClone still runs `npm ci` on the data clone inline when the lockfile changes — run it as a
job against a fresh node_modules store and swap at a pass boundary;
(3) the drain imports `rebuildClone` from the data clone once per process, so WE rebuild changes reach it only on
a drain restart — have the drain reload on a rebuild-code change.
Done when: tests; LIVE proof: a self-update with a lockfile change shows no tick gap longer than one interval on
each daemon, from the timestamped log.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

## Non-goals

- [N1] n/a: to be stated when the item is prepared.
