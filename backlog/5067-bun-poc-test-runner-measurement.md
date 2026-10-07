---
bornAs: xkd7crs
kind: story
size: 3
status: open
scope: ["we:bun-test.preload.ts"]
dateOpened: "2026-10-04"
tags: ["testing", "infra", "perf"]
---

# Bun POC: bun test and bun-run scripts measured against vitest+node (partial go)

Measurement POC: can Bun replace vitest+node for scripts/__tests__ and script runs, to cut the slow local verify on a loaded host? Findings, blocker counts and a partial-go recommendation; the opt-in shim we:bun-test.preload.ts is the only code.

Motivation: local verify is slow on a host with ~90 lane clones at load ~20, and node startup alone was seen
producing ~7,500 file events per 10s out of `.nvm`. This was a measurement only. The default toolchain
(`npm run test:*` = vitest on node) and all daemons are unchanged.

## Setup

- Bun 1.4.2 via `npx --yes bun@latest` (npx cache only; no global install, no devDependency).
- Lane clone at `c1fdfb151`, host load 8 to 15 during runs.
- Sample: 31 files of the 198 in `we:scripts/__tests__/`, stratified: 3 mock/timer-heavy, 10 git-fixture,
  9 child_process, 9 pure. 24 of them are in the default vitest suite; 7 belong to
  `we:vitest.integration.config.ts`.
- Bun runs use `bun test` with `--preload` pointing at the shim `we:bun-test.preload.ts`. The shim reuses
  `we:vitest.setup.ts` and adds what Bun lacks: the `VITEST` env marker, `vi.stubEnv`/`vi.unstubAllEnvs`, and
  approximate `vi.runAllTimersAsync`/`vi.advanceTimersByTimeAsync`.

## Compatibility (per file, each file in its own process)

| | files passing |
|---|---|
| bun test, no shim | 29 / 31 (94%) |
| bun test, with shim | 30 / 31 (97%) |

Failure categories:

1. `vi.stubEnv` / `vi.unstubAllEnvs` missing: 1 sample file (147 tests); 6 of 198 files use it. Shimmed.
2. Async fake timers (`runAllTimersAsync`, `advanceTimersByTimeAsync`) missing; Bun has only the sync forms:
   1 of 198 files. Shimmed (approximate: step one timer, flush microtasks).
3. `vi.mock(path, async (importOriginal) => ...)`: Bun calls the factory with no argument, so the whole file
   aborts (we:scripts/__tests__/operator-queue.test.mjs, 56 tests lost). 1 of 198 files. NOT shimmable from
   a preload.
4. `vi.doMock` / `vi.resetModules`: 1 of 198 files (we:scripts/__tests__/pr-land-delegation.test.mjs), not
   in the sample, untested.

## Blockers for a real migration (counts)

- **Isolation is opt-in.** Running all files in one process (Bun's default) failed 51 tests that pass alone:
  `vi.mock('node:child_process')` from one file leaked into every later file's git spawns. A migration must
  always pass `--isolate` or `--parallel`. 2 of 198 files use `vi.mock`.
- **Safety guards key off `env.VITEST`.** 7 production scripts (we:scripts/lib/lane-pool-paths.mjs,
  we:scripts/lib/gh-rest-read.mjs, ...) refuse the real lane pool / real gh only when `VITEST` is set. Bun does
  not set it, so a bare `bun test` can reach real operator state. The shim sets it first. Any migration must
  rename this to a runner-neutral marker.
- **`process.execPath` changes meaning.** 38 of 198 test files spawn `process.execPath`; under Bun the child
  scripts run under Bun, not node, so those tests no longer test the node runtime that daemons use.
- **Config does not port.** Include/exclude lists, the unit vs integration split, `pool: 'forks'` overrides,
  happy-dom, coverage thresholds and esbuild `jsxInject` all live in we:vitest.config.ts. Bun has no
  equivalent for `jsxInject` or per-path pool choice. The other ~820 test files in the repo (`.ts`/`.tsx`,
  DOM and JSX) were not tried.
- `importOriginal` mock factories: 1 file must be rewritten.

## Speed and memory

Test runner, the 23 default-suite sample files (the outlier check-standards test excluded, see below),
cleanest run of two:

| | wall | CPU (user+sys) | peak RSS (largest process) | tests run |
|---|---|---|---|---|
| vitest on node | 39.2 s | 45.4 s | 835 MB | 822 |
| bun test `--isolate --parallel=4` | 22.2 s | 28.9 s | 551 MB | 766 |

About 43% less wall time, 36% less CPU, 34% lower peak RSS. Caveat: Bun ran 56 fewer tests (category 3).
The first vitest run took 151 s because it overlapped another timing run; the bun numbers were stable (26 s, 22 s).

Outlier: we:scripts/__tests__/check-standards.test.mjs spawns we:scripts/check-standards.mjs through
`process.execPath`. Alone it took 133 s under bun vs 90 s under vitest, and 403 s for one test under
`--parallel=4` (memory pressure, below).

Bare startup, 10 runs of `-e 0`: node 1.06 s, bun 0.20 s (about 5x faster per process).

Scripts run directly (node vs bun, same arguments):

| script | node wall / RSS | bun wall / RSS | output |
|---|---|---|---|
| we:scripts/lane-pool.mjs `status --json` | 17.8 s / 123 MB | 22.5 s / 71 MB | identical |
| we:scripts/backlog.mjs `build-queue --json` (3 runs) | 4.9 to 5.6 s / 445 MB | 3.1 to 3.5 s / 785 to 863 MB | equal except time-decayed `score` |
| we:scripts/check-standards.mjs `--json` | 29.1 s / 1.45 GB | 26.6 s / 2.59 GB | same findings, different warning order |

`lane-pool status` is bound by git spawns (38 s sys time either way), so the runtime does not matter there.
For the heavy in-process scripts, bun is 10 to 35% faster but uses about 1.8x the memory. On this host,
which is memory-bound with many lanes, that is a real cost.

File events: not measured directly (`fs_usage` needs root). Proxy: Bun is one static binary, so it does not
walk `.nvm` on startup, and new tmpdir entries per run were lower under bun (285 to 373 vs 519 to 1014), but
`$TMPDIR` is shared across the host, so that number is noisy. Side finding: listing `$TMPDIR` took about
107 s, which points to test temp-dir leaks across the host.

## Recommendation: partial go

- **Go (opt-in): `bun test` for `scripts/__tests__` pure and child_process files**, always with `--isolate`
  or `--parallel`. It is clearly faster and lighter, and 97% of sampled files pass with the shim.
- **No-go for now: bun as the script runtime** (scripts and daemons). The speed gain is modest and the heavy
  scripts use about 1.8x the memory.
- **No-go: replacing vitest repo-wide.** The `.ts`/`.tsx` DOM/JSX suites, the config split and coverage
  do not port, and the `VITEST` safety guards must be made runner-neutral first.

Owed before any opt-in lane: make the 7 `env.VITEST` guards runner-neutral; rewrite the 1 `importOriginal`
factory; add a `test:bun:scripts` entry that pins Bun's version and always isolates; run the full 198 files
once to confirm the 97% holds beyond the sample.

## Done when

1. **Executable** — `npx --yes bun@1.4.2 test` with `--preload` set to we:bun-test.preload.ts, on
   we:scripts/__tests__/gemini-direct-task.test.mjs, reports 147 pass, 0 fail (0 pass, 147 fail without the
   shim).
2. The operator rules on the recommendation above, and the owed follow-ups are filed or declined.

## Native trial (item 112, 2026-10-07): tests rewritten for bun:test, no shim

Code: we:bun-trial/setup.ts (native `--preload` replacing we:vitest.setup.ts), we:bun-trial/env-stub.ts, we:bun-trial/tools/port.mjs
(codemod), we:bun-trial/tools/measure.sh, 47 test copies mirrored under we:bun-trial/scripts/. vitest, package scripts and CI are
untouched. Run: `bun test --parallel=4 --preload we:bun-trial/setup.ts <files in we:bun-trial/slice.txt, prefixed bun-trial/>`.

Slice: 17 slowest by recent vitest timing, 22 mock-module files, 8 plain. 2126 vitest tests; bun passes all but 13
(gh-app-shim 7, docket-refresh 5, judge-spawn firmlink 1).

Host was NEVER quiet (1-min load 16 to 44 on 12 cores, 1.3 to 3.7 per core; load checked, then measured with load
recorded). Peak RSS = `/usr/bin/time -l` largest process; the bun small-run RSS (about 70 MB) only saw the parent: unusable.

| run | runner | wall s (3 runs) | CPU s user+sys | peak RSS MB | load at start |
|---|---|---|---|---|---|
| (a) 4 files, 284 tests | vitest | 60.8 / 56.8 / 54.2 | 50.7 / 49.9 / 47.8 | 1012-1028 | 16 / 27 / 28 |
| (a) | bun | 42.7 / 35.0 / 37.1 | 27.7 / 25.6 / 27.3 | n/a | 26 / 23 / 33 |
| (b) 47 files, 2126 tests | vitest | 156.5 / 142.8 / 140.0 | 450 / 422 / 418 | 1677 / 1437 / 1449 | 35 / 37 / 30 |
| (b) | bun (13 tests fail) | 123.6 / 155.7 / 117.3 | 385 / 390 / 373 | 1130 / 1139 / 1140 | 22 / 44 / 40 |

(a) bun is about 35% faster wall and 45% less CPU. (b) bun median wall is 13% better but one run was slower than every
vitest run (load 44), CPU only 8% lower, and 13 tests do not pass. Not a clear win on both.

Per-file outliers (sequential, one process each; bun wall vs vitest duration under load): bun wins big on
lane-drain-numbering 27 vs 56 s, ci-heal-mark 38 vs 59, health-watch 28 vs 46, probation-build-run 25 vs 38,
card-batch-io 21 vs 30. Ties (child-process bound): queue-prune, principle-surface, queue, daemon-rebuild-ready
(51 vs 54). Small files lose to ~0.3 s bun process start. Hang outlier: an async `mock.module` factory that awaits
`import()` of another mocked module (duplicate-pr-watch, parked-pr-progress-watch) spins at 100% CPU forever and the
test timeout never fires.

No clean bun equivalent: `importOriginal` factory argument (snapshot the module before mocking instead); `vi.resetModules`
/`vi.doMock` (ESM registry cannot be cleared, cache-bust with a `?n` query); `vi.stubEnv`/`unstubAllEnvs` (own helper);
`vi.hoisted` and mock hoisting (order by hand); `vi.setConfig` (only global `setDefaultTimeout`); `ctx.skip()` test
context (none; a test taking an arg waits for a done callback and times out); async fake timers. Also: `--isolate`/
`--parallel` is opt-in, the `VITEST` guard env must be set by the preload, child `node` becomes bun (gh-app-shim,
docket-refresh differ; `realpathSync.native` resolves firmlinks differently), no per-path pool or happy-dom config.

Verdict: NO-GO to adopt. (a) is a clear win, (b) is not (noisy 13% wall, 8% CPU, 13 non-portable tests, hand rewrite
per mock-heavy file). Re-measure on a quiet host only if the 13 gaps are closed.
