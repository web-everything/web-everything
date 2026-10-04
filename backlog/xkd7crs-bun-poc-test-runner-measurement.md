---
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
