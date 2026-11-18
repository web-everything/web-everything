---
bornAs: x45rs01
kind: story
size: 3
priority: high
status: resolved
scope: ["we:scripts/readiness/heavy-admission.mjs", "we:scripts/conveyor/tick-core.mjs", "we:scripts/readiness/__tests__/heavy-admission.test.mjs", "we:scripts/conveyor/__tests__/tick-core.test.mjs"]
dateOpened: "2026-09-28"
dateStarted: "2026-09-28"
dateResolved: "2026-09-28"
preparedDate: "2026-09-28"
preparedAgainstSha: "c7e4fd628fd6ee4436b82103f7d1ce35ca7fd8a7"
tags: []
---

# Load-cap admits on instantaneous load average, which our own fork storm inflates; admit on CPU idle and memory pressure instead

Tick-core's `load-cap` (#4076) holds every build and every prepare/fix/ci-heal lane when ONE host-sampler
reading of `load1 / cores` is above 1.5 (load1 > 18 on the host). On macOS the load average counts
runnable threads. Our own daemons start about 400 short-lived processes per second (cards 4344, 4345,
4346). That pushes load1 into the 20s–60s while about 45% of CPU sits idle and memory is never under pressure.
So the gate holds dispatch because of our own polling, not because the host lacks capacity.

## Evidence (read-only, 2026-09-28)

- 08:30 ET (operator): tick-core held 6 builds `load-cap` "host load 21.24/host core count (1.77 > 1.5)". `top` at
  08:40: load 27.7, **CPU 14.4% user, 56.2% sys, 29.6% idle**, memory 92% free.
- Host-sampler, today's file (`~/workspace/.operations/telemetry/2026-09-28.jsonl`, 3239 `host.cpu.busy_pct`
  samples, 30 s interval): idle% p5/p50/p95 = 25.8 / 43.5 / 66.4. **sys% median 39**, user% median 15.3 (p95
  32.2). `host.mem.pressure_level` is 1 (normal) in all 3239 samples.
- Overnight 02:00–10:20Z (little dispatch), load1 averaged 10–13 per 20-minute bucket, with bucket maxima of
  15–25 and sys steady at 37–40%. That is the baseline of the daemons alone. Since 12:00Z, maxima reached 59–70.
- Hold rate on today's data: the current rule (`load1 > 18`, single sample) holds on **7.5%** of samples (20%
  since 12:00Z). A 2-minute median of load1 does not help (8.0%). A 2-minute median of `idle_pct < 15` would
  hold on **0.7%**.
- Fork rate, measured from the PID counter over a 239 s window at 08:46 ET: median 414 new PIDs per second (p10
  280, p90 641). A 1 s `ps` sampler caught only 1811 of those processes, so about 98% live under a second. That
  is kernel (sys) time, not work.
- 08:44 ET: we:scripts/readiness/heavy-admission.mjs `load-status --json` returned
  `{"held":false,"load1":10.66,...}`. Four minutes earlier load1 was 28, so the gate flips from tick to tick.

## Cause (code)

- we:scripts/readiness/heavy-admission.mjs L300–319 `loadAdmissionDecision`: `held = load1/cores > 1.5`.
  L335–341 `readLatestLoad` reads only the latest `host.cpu.load1` sample, with no smoothing.
- we:scripts/conveyor/tick-core.mjs L1260, L1279, L1324: `loadHeld` withholds all admitted builds and empties the
  prepare/fix pool.

## Fix (proposed signal, thresholds from the samples above)

Replace the load1 ratio with a decision over the last ~2 minutes of samples the host-sampler already writes
(`host.cpu.busy_pct` with `idle_pct`/`user_pct`/`sys_pct` attributes, and `host.mem.pressure_level`):

- Hold when the **median `idle_pct` over the last 4 samples is below 15**. The baseline p5 is 25.8, so 15 is
  below every normal reading and above real saturation.
- Also hold when `host.mem.pressure_level >= 2` (warn) on the latest sample.
- Keep load1 only as a runaway backstop at a much higher ratio (for example `perCore > 4`, load1 > 48 here). The
  2026-09-07 cascade (34.95/12 ≈ 2.9) would still have shown up through idle%.
- A missing sample still fails open, as today. Keep `WE_LOAD_ADMISSION=off`. Add env knobs
  `WE_LOAD_ADMISSION_MIN_IDLE_PCT` (default 15) and `WE_LOAD_ADMISSION_WINDOW` (default 4).
- The heavy-admission queue's projected wait is already its own gate (`queue-cap`, card 4200). Leave it
  separate.
- Update `loadCapReading` so the note names the real signal, for example `cpu idle 12% (<15%)`.

## Risks

- Idle% ignores I/O stalls. Memory pressure covers swap. This host has shown no disk I/O problem.
- If the load1 gate goes but the fork storm stays (cards 4344/4345/4346), dispatch runs on top of 39% sys.
  That is still fine while idle stays at 40% or more.

## Test plan (each fails before the fix)

- `loadAdmissionDecision` with load1 27.7, cores 12, idle window [29.6, 31, 35, 40], pressure 1 → `held:false`.
- Idle window [10, 12, 14, 30] → `held:true`, and the reason names idle%.
- pressure_level 2 with idle 50 → `held:true`.
- load1 60, cores 12 (perCore 5 > 4) → `held:true` (backstop).
- No busy_pct samples → `held:false`, `reason:'no-sample'`.

## Live proof plan

Before: when `load-status --json` reports `held:true` with load1 > 18, capture the host-sampler's latest
idle_pct (expected about 30–45%) and tick-core's `load-cap` notes. After landing, at a comparable load1,
we:scripts/readiness/heavy-admission.mjs `load-status --json` reports `held:false` and shows the idle reading. The
builder's own `--dry-run` from `~/workspace/wev-control` then shows a non-empty tick-core `spawnBuilds`. Once card
4342 has landed, the same dry run also lists items under `would dispatch now`.

## Done when

1. **Executable** — vitest on we:scripts/readiness/__tests__/heavy-admission.test.mjs passes with the cases above, which fail on main.
2. **Live** — `load-status` stays `held:false` through a load1 > 18 spike while idle_pct stays at 15 or more.

## Progress

- Replaced the `load1/cores` primary threshold with a 3-condition decision in `loadAdmissionDecision`: idle%
  (median over the last 4 `host.cpu.busy_pct` samples, floor 15%), memory pressure (latest sample, `>= 2`), and
  `load1/cores` demoted to a runaway backstop — now ALSO a median over the same window (a review round caught
  that an unwindowed backstop at the new, higher ratio could itself still spuriously hold on an ordinary
  fork-storm burst, reintroducing this card's own bug at a higher threshold).
- New env knobs: `WE_LOAD_ADMISSION_MIN_IDLE_PCT` (15), `WE_LOAD_ADMISSION_WINDOW` (4),
  `WE_LOAD_ADMISSION_MIN_PRESSURE_LEVEL` (2). The backstop ratio's env var was renamed to
  `WE_LOAD_ADMISSION_BACKSTOP_PER_CORE` (default 4) rather than reusing the old `WE_LOAD_ADMISSION_MAX_PER_CORE`
  — that name meant the old, much-lower primary threshold (1.5), and reusing it would let an existing low
  override silently reintroduce this bug on any machine that still has it set.
- `we:scripts/conveyor/tick-core.mjs`'s `loadCapReading` now surfaces the decision's own `reason` string (e.g.
  `cpu idle 12% (<15%)`) instead of a bare load1 ratio.
- Converged via the real `/converge` loop (panel → editor → red-team) across several rounds; findings fixed
  along the way: a CLI `NaN`/out-of-range override bypass on all four knobs (garbage or `0`/`1`-style values
  silently disabled a check instead of falling back to its default), the same bypass class on direct JS-caller
  params to `resolveLoadAdmission`, the backstop-windowing gap above, and several test-coverage gaps (window
  round-trip, mem-pressure latest-sample-only, decision precedence when multiple conditions hold at once, the
  plain-text CLI branch). Remaining panel findings were cosmetic style preferences or a tool-free reviewer's
  structural inability to see the card's own (undiffed) Evidence section — both dismissed with a stated reason.
- Live proof (2026-09-28, this host): `load-status --json` → `{"held":false,"idlePct":16,"load1":28.55,
  "cores":12,"perCore":2.38,...}` — load1 well over 18 (and over the OLD 1.5/core threshold, which would have
  held at 2.38), idle_pct at 16 (>= the 15 floor), gate ADMITS. Satisfies Done-when #2.
