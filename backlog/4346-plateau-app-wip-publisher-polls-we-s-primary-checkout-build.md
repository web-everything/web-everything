---
bornAs: xvgqaqg
kind: story
size: 2
priority: high
status: open
scope: ["plateau-app:src/wip/wip-source.ts", "plateau-app:scripts/wip-publish.ts"]
dateOpened: "2026-09-28"
preparedDate: "2026-09-28"
preparedAgainstSha: "c7e4fd628fd6ee4436b82103f7d1ce35ca7fd8a7"
tags: []
---

# plateau-app wip-publisher polls WE's primary checkout (build-queue, live-state, runner-activity) every 30 s

The `com.plateau.wip-publisher` launchd job runs `npm run wip:publish` in `~/workspace/plateau-app`, which runs
plateau-app:scripts/wip-publish.ts under vite-node. It starts a publish cycle every 30 s. Each cycle runs WE
operations from the PRIMARY checkout `~/workspace/webeverything`: we:scripts/backlog.mjs `build-queue --json`, and
the `runner-activity` and `live-state` operations through we:scripts/operations/run.mjs. `live-state` calls the
pool's `status --json`, which is 364 git processes (card 4345). This answers the question "who runs
build-queue from the primary checkout?": it is this publisher, not a WE daemon. It is the largest single CPU tree
on the host. It is not a direct dispatch blocker, but it feeds the sys time behind load-cap (card 4343).

## Evidence (read-only, 2026-09-28 08:46–09:00 ET)

- Parent chains from `ps`: the primary checkout's `build-queue --json` process ← the vite-node publisher (pid
  95944) ← `npm run wip:publish` (pid 95739, cwd `~/workspace/plateau-app`, launchd
  `com.plateau.wip-publisher`). The primary checkout's pool `status --json` ← the `live-state --json` operation ←
  the same vite-node process. It lasts about 20 s each time.
- Cadence: plateau-app:src/wip/wip-source.ts L20 `PUBLISH_EVERY_MS = 30_000`. The comment at L15 says a cycle
  "costs real work (backlog scan, `gh`, `build-queue`, the runner check)".
- CPU: pid 95944 alone has 152 CPU-minutes after 1 day 0 h 48 m of uptime (about 10% of a core, children not
  counted). In a 4-minute 1 Hz sample its whole tree used **118 CPU-s**, the most of any daemon tree (the three
  health-watch trees together used 84, review-daemon 36, build-dispatch 25). Within it: `build-queue` used 29.6
  CPU-s (8 runs), the runner-activity snapshot 23.6 CPU-s (8 runs), and there were 61 `git status` spawns.
- Forks: in a 45 s tight `ps` sample, children of the pool `status` call made by this publisher's `live-state`
  were 544 of the 2371 caught processes (23%).

## Fix (smallest)

1. plateau-app:src/wip/wip-source.ts L20: raise `PUBLISH_EVERY_MS` to 120 s. The page's evidence ages over
   minutes, not seconds.
2. Once card 4345 lands, have `live-state` use the pool's `status --leased-only`. That change lives in WE's
   live-state operation, so track it there if it is out of scope here.
3. Follow-up, not in this card: read the conveyor's own last tick output instead of recomputing `build-queue` each
   cycle.

## Risks

- The /wip page updates less often. At 120 s it still refreshes faster than one conveyor tick (about 4 minutes).
- Running from the primary checkout means the publisher reads whatever that tree holds. Pointing it at a daemon
  clone is a separate decision and is not proposed here.

## Test plan (each fails before the fix)

- A unit test pinning `PUBLISH_EVERY_MS` at 120 000 or more, next to the existing wip-source tests in plateau-app.

## Live proof plan

Before: the numbers above (118 CPU-s per 4 minutes, 23% of spawns). After it deploys, rerun the 4-minute 1 Hz sample
and the 45 s tight sample. The publisher tree should drop to about a quarter of its CPU and spawns. Then run the
builder's own `--dry-run` from `~/workspace/wev-control` and check whether `load-status` still holds.

## Done when

1. **Executable** — the plateau-app unit test pinning the cadence passes and fails on main.
2. **Live** — the publisher tree uses under 40 CPU-s in a 4-minute sample.

Will be closed when plan step PD-LIVE (delivery plan) delivers; ruled 2026-11-22 (PL-WIP-CLEANUP).
