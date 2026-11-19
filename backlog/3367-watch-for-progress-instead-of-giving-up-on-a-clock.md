---
bornAs: xnukacf
kind: story
size: 3
parent: "3029"
status: open
scope: ["we:scripts/operations/dispatch-lane-io.mjs", "we:scripts/operations/dispatch-lane.mjs"]
dateOpened: "2026-08-27"
tags: [operations, conveyor, dispatch, watchdog, liveness]
---

# Watch for progress instead of giving up on a clock

Every watchdog in the loop is a deadline standing in for the question *"is it still working?"*. A deadline
answers that question wrong in both directions: it kills healthy work on a busy machine, and it waits out the
full interval before noticing work that wedged in the first second. Replace the deadlines that guard *live
work* with a progress check — has this produced anything recently — so a slow machine is tolerated and a
genuinely stuck process is caught sooner.

## The deadlines that stand in for liveness today

| Where | Value | The question it is really asking |
|---|---|---|
| `defaultListAgents` `spawnSync` timeout (`we:scripts/operations/dispatch-lane-io.mjs`) | seconds | is the CLI responding? |
| `DISPATCH_LISTING_GRACE_MINUTES` (`we:scripts/operations/dispatch-lane.mjs:111`) | 2 min | did the agent start? |
| lane lease TTL (`we:scripts/lane-pool.mjs`) | 240 min | is the holder alive? |

## What made this concrete

On 2026-08-27 five `verify-lane` runs were started concurrently on the machine. All five failed, and
**every failure was a spawn killed by its own deadline** — `errno: -60, code: 'ETIMEDOUT', signal: 'SIGKILL',
stdout: '', stderr: ''`, with no output from the child at all. The failures landed exclusively on the four
test files that spawn real processes (`we:scripts/operations/__tests__/wake-cli.test.mjs`,
`we:scripts/operations/__tests__/dispatch-spawn-live.test.mjs`,
`we:scripts/__tests__/lane-pool-reap-on-acquire.test.mjs`, `we:scripts/__tests__/progress-board.test.mjs`);
every other suite passed in all five runs. Nothing was broken. The machine was busy.

**A ratio is not enough, and this is the evidence.** `we:scripts/operations/__tests__/dispatch-spawn-live.test.mjs:123-144`
already anticipated load and deliberately asserts a COMPARATIVE bound, with the reasoning in the file: *"an
absolute `background < 1_000` is a flake waiting for a loaded machine… Comparing the two runs of the SAME shim
in the SAME process cancels the load out."* It still failed — `expected 47698 to be less than 28283`. A ratio
only cancels load if load is constant across both measurements, and under contention it is not. So the fix is
not "pick better numbers" or "compare instead of bound": it is to stop asking the clock.

## Done when

1. **Executable** — a test in which a child produces output slowly but steadily for longer than the old
   deadline and is NOT killed, and a second in which a child produces nothing and IS killed after the quiet
   threshold. Both must fail against `main`.
2. **A quiet-interval watchdog exists** in the io shell: a spawn is killed only after N consecutive intervals
   with no observable progress, not after a total elapsed time. N and the interval are named constants with
   the reasoning written down, and env-overridable the way the current bounds are.
3. **`spawnSync` is replaced where progress must be observed.** A synchronous spawn CANNOT watch its child —
   this is the real cost of the item and the reason it is not a config change. Each converted call site keeps
   its existing refusal behaviour on a genuinely-stuck child.
4. **The absolute bound survives as a backstop, not as the primary guard** — a wedged child that also emits
   noise must still die eventually. Say in the code why the backstop is where it is.
5. **The 2-minute listing grace is derived from the same mechanism or explicitly exempted with a reason.** It
   is the deadline whose wrong answers actually cost time today (see `#3331`).

## Deliberately NOT in scope

- **The comparative assertion in `we:scripts/operations/__tests__/dispatch-spawn-live.test.mjs:123`.** That is
  a PROPERTY test — "`--bg` returns while the foreground blocks" — not a runaway guard, and a heartbeat cannot
  express it. It needs serialisation or repeated measurement, which is a separate and smaller card.
- **Test-runner concurrency.** How many suites run at once is a different lever; this item makes the guards
  robust rather than making the machine quieter.
- **What to DO when the watchdog fires.** Resuming rather than relaunching is `#3366`.

## Lineage

Filed 2026-08-27. Pairs with `#3368` (step timings): every threshold named here is currently a guess, and
tuning any of them honestly needs the duration data that card records.
