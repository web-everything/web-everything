---
bornAs: x0m7a8x
kind: story
size: 3
parent: "4075"
status: resolved
scope: ["we:scripts/lib/daemon-self-sync.mjs", "we:scripts/lib/daemon-rebuild/deps-job.mjs", "we:scripts/lib/daemon-rebuild-settings.json", "we:scripts/lib/__tests__/daemon-background-build.test.mjs", "we:scripts/lib/__tests__/review-daemon-first-pass.test.mjs", "we:scripts/lib/__tests__/daemon-deps-job.test.mjs", "plateau-app:tools/drain-daemon/daemon.mjs", "plateau-app:tools/drain-daemon/lib.mjs", "plateau-app:tools/drain-daemon/lib.test.mjs"]
dateOpened: "2026-10-09"
dateStarted: "2026-10-10"
dateResolved: "2026-10-10"
tags: []
---

# Builder and fix daemons and the drain's data-clone npm ci adopt the rebuild job (4126 part 2)

Slice 2 of #4126. Slice 1 (lane/jobmodel-4126) moved the shared clone rebuild + live smoke into a detached durable
job (we:scripts/lib/daemon-rebuild/rebuild-job.mjs on the daemon-jobs runtime) for the drain, review,
build-dispatch and fix daemons: the tick adopts only a smoke-passed ready candidate. Remaining:
(1) the fix daemon still runs the pre-job 5561 builder process, which now only launches the rebuild job and
adopts its result — retire the bespoke builder record (we:scripts/lib/daemon-background-build.mjs) once the job
covers its re-clone and swap-spacing rules;
(2) the drain's refreshClone still runs `npm ci` on the data clone inline when the lockfile changes — run it as a
job against a fresh node_modules store and swap at a pass boundary;
(3) the drain imports `rebuildClone` from the data clone once per process, so WE rebuild changes reach it only on
a drain restart — have the drain reload on a rebuild-code change.
Done when: tests; LIVE proof: a self-update with a lockfile change shows no tick gap longer than one interval on
each daemon, from the timestamped log.

## What landed

1. **Builder process retired.** we:scripts/lib/daemon-self-sync.mjs never starts the x44lnnt builder: every tick runs
   the rebuild job's fast tick side (adopt a smoke-passed candidate at once, else queue or watch the job). This removes
   the builder's 5-min start coalesce, which held a passed build up to 5 min before the swap (live 2026-10-10: job
   finished 14:04:46Z, adopted 14:11:00Z). Kept unchanged: the swap only between ticks, at most once per
   `swapMinIntervalMs` for the daemons listed in we:scripts/lib/daemon-background-build-settings.json; the
   tick-starved smell; every smoke / last-good / adoption rule (they live in the job and `rebuildClone`).
   The re-clone fail-closed rule moved here: a re-cloned checkout (seen directly, through a finished job, or as a
   changed checkout identity under the read lock) runs no children until a rebuild on it concludes, persisted per
   clone (a `recloned` marker file in the daemon state dir) so a restart keeps it. `WE_DAEMON_BACKGROUND_BUILD` now only selects
   the swap spacing, which the settings file already sets for the fix and review daemons.
2. **Drain npm ci as a job.** we:scripts/lib/daemon-rebuild/deps-job.mjs: an install job on the shared job runtime
   builds a lockfile-keyed `node_modules` store detached; the drain swaps it in at a pass boundary
   (plateau-app:tools/drain-daemon/daemon.mjs `refreshDeps`). Setting `depsAsJob` (env `WE_DAEMON_DEPS_AS_JOB` >
   file > built-in on), source logged once. Inline `npm ci` stays only as the fallback when the module is missing or
   the setting is off.
3. **Drain reload.** The drain fingerprints the import closure of each WE rebuild module it loaded
   (daemon-rebuild, daemon-overlays, deps-job) and, when a refresh or a code-clone job swap changes one, releases the
   lease and exits between passes (launchd restarts it), behind the existing 5-min restart floor.

Follow-up (blocked on #4772, which holds we:scripts/lib/daemon-background-build.mjs): delete the now-unused builder
helpers + CLI, and fix the rebuild job's consumed-ids file being listed as a corrupt job record.

## Acceptance

- [A1] **Executable** — `npm run test:unit --` on we:scripts/lib/__tests__/daemon-background-build.test.mjs,
  we:scripts/lib/__tests__/review-daemon-first-pass.test.mjs and we:scripts/lib/__tests__/daemon-deps-job.test.mjs, and
  `npx vitest run` on plateau-app:tools/drain-daemon/lib.test.mjs: no builder start with the env set, the job
  path ticks every 3 min or less with the swap at most one tick past the job finishing, the re-clone block, the
  install job + swap, and the drain reload decision. The builder and re-clone-marker tests fail before this change.
- [A2] **Live** — the fix daemon log shows a rebuild completed via the job with no `daemon-rebuild-builder` / inline
  smoke line and the swap within one tick of the job finishing; the drain log shows `deps:` job lines and no inline
  `npm ci`, and a reload line after a rebuild-code change.

## Non-goals

- [N1] Does not change the rebuild job, the smoke, the adoption or last-good rules, or the swap spacing values.
- [N2] Does not delete the builder helpers in we:scripts/lib/daemon-background-build.mjs (held by #4772; follow-up card).
