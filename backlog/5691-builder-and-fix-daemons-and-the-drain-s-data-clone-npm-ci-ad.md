---
bornAs: x0m7a8x
kind: story
size: 3
parent: "4075"
status: active
scope: ["we:scripts/lib/daemon-self-sync.mjs", "we:scripts/lib/daemon-rebuild/deps-job.mjs", "we:scripts/lib/daemon-rebuild-settings.json", "we:scripts/lib/__tests__/daemon-background-build.test.mjs", "we:scripts/lib/__tests__/review-daemon-first-pass.test.mjs", "we:scripts/lib/__tests__/daemon-deps-job.test.mjs", "plateau-app:tools/drain-daemon/daemon.mjs", "plateau-app:tools/drain-daemon/lib.mjs", "plateau-app:tools/drain-daemon/lib.test.mjs"]
dateOpened: "2026-10-09"
dateStarted: "2026-10-10"
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
   the builder's 5-min start coalesce, which held a passed build up to 5 min before the next builder start; the
   swap then also waited for the next tick boundary, so the lag could exceed 5 min (live 2026-10-10: job finished
   14:04:46Z, adopted 14:11:00Z — 6 min 14 s). Kept unchanged: the swap only between ticks, at most once per
   `swapMinIntervalMs` for the daemons listed in we:scripts/lib/daemon-background-build-settings.json; the
   tick-starved smell; every smoke / last-good / adoption rule (they live in the job and `rebuildClone`).
   The re-clone fail-closed rule moved here: a re-cloned checkout (seen directly, through a finished job, or as a
   changed checkout identity under the read lock) runs no children until a rebuild on it concludes, persisted per
   clone (a `recloned` marker file in the daemon state dir) so a restart keeps it. The rebuild path (inline or job) is
   resolved once and passed explicitly to both the rebuild and the re-clone rule, never read off a result's shape.
   Inline: any rebuild verdict concludes (as the pre-job inline path did). Job: only a job that ran on the fresh
   checkout concludes — `succeeded` (a rejected smoke included) or `failed` because its rebuild child crashed after
   starting (the retired builder counted a thrown rebuild as a finished run); never a job that could not launch, one
   queued before the re-clone (every rebuild job in the clone's SHARED job store when the marker is written, so a
   sibling daemon's or a pre-restart process's job counts too; a store that cannot be listed means no finished job
   concludes), or a spaced / started / running answer. Both: an adoption or `up-to-date`. The
   conclusion is written only if the marker is still the one read (a sibling daemon's newer re-clone marker is
   never overwritten). A corrupt marker file blocks; an unwritable state dir keeps the marker in memory and logs it.
   `WE_DAEMON_BACKGROUND_BUILD=1` now selects the rebuild job (off the tick path) for an unlisted daemon plus the swap
   spacing; `=0` turns off only the swap spacing (the rebuild path is set by `WE_DAEMON_REBUILD_AS_JOB` /
   we:scripts/lib/daemon-rebuild-settings.json).
2. **Drain npm ci as a job.** we:scripts/lib/daemon-rebuild/deps-job.mjs: an install job on the shared job runtime
   builds a lockfile-keyed `node_modules` store detached; the drain swaps it in at a pass boundary
   (plateau-app:tools/drain-daemon/daemon.mjs `refreshDeps`). Setting `depsAsJob` (env `WE_DAEMON_DEPS_AS_JOB` >
   file > built-in on), source logged once. Inline `npm ci` stays only as the fallback when the module is missing or
   the setting is off. A swap whose final rename fails renames the old `node_modules` back; leftover swap dirs from a
   crashed process are cleaned on the next swap.
3. **Drain reload.** The drain fingerprints the import closure of each WE rebuild module it loaded
   (daemon-rebuild, daemon-overlays, deps-job) and, when a refresh or a code-clone job swap changes one, releases the
   lease and exits between passes (launchd restarts it), behind the existing 5-min restart floor.

Still open before this card resolves: items 2 (the drain's `refreshDeps` swap) and 3 (the drain reload) live in a
separate plateau-app PR, linked here once it opens; and the A2 live proof is collected after both PRs open. This
WE change carries only the deps-job module and the daemon-self-sync side.

Follow-up (blocked on #4772, which holds we:scripts/lib/daemon-background-build.mjs): delete the now-unused builder
helpers + CLI, and fix the rebuild job's consumed-ids file being listed as a corrupt job record.

## Acceptance

- [A1] **Executable** — `npm run test:unit --` on we:scripts/lib/__tests__/daemon-background-build.test.mjs,
  we:scripts/lib/__tests__/review-daemon-first-pass.test.mjs and we:scripts/lib/__tests__/daemon-deps-job.test.mjs, and
  `npx vitest run` on plateau-app:tools/drain-daemon/lib.test.mjs: the job tick side runs every tick with the env
  set, env `WE_DAEMON_BACKGROUND_BUILD=0` still selects the plain restart window, the job path ticks every 3 min or
  less with the swap at most one tick past the job finishing, the re-clone block (inline verdicts, stale jobs, the
  stale-refusal rebuild, corrupt / unwritable marker), the install job + swap (incl. the swap rollback), and the drain
  reload decision. The re-clone-marker tests fail before this change.
- [A2] **Live** — the fix daemon log shows a rebuild completed via the job with no `daemon-rebuild-builder` / inline
  smoke line and the swap within one tick of the job finishing; the drain log shows the install job's lines — the
  drain's own `deps:` summary lines and the module's `deps-job:` lines (grep `deps(-job)?:`) — and no inline
  `npm ci`, and a reload line after a rebuild-code change.

## Non-goals

- [N1] Does not change the rebuild job, the smoke, the adoption or last-good rules, or the swap spacing values.
- [N2] Does not delete the builder helpers in we:scripts/lib/daemon-background-build.mjs (held by #4772; follow-up card).
