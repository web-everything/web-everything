---
bornAs: xx9pv1n
kind: story
size: 3
status: resolved
scope: ["we:scripts/operations/live-state-io.mjs", "we:scripts/operations/agent-activity-io.mjs", "we:scripts/operations/__tests__/live-state-io.test.mjs", "we:scripts/operations/__tests__/agent-activity-io-real.test.mjs"]
dateOpened: "2026-10-03"
dateStarted: "2026-10-03"
dateResolved: "2026-10-03"
graduatedTo: none
preparedDate: "2026-10-03"
preparedAgainstSha: "e1f0523e0881357fc863f3e88da72e0164eb7091"
tags: []
---

# WIP feed reads finish inside their time limit and the conveyor check never reports stopped when unsure

Live 2026-10-02: Plateau's /wip page showed unknown everywhere. The running-jobs read takes about 35s but is cut at 30s; the conveyor check times out and the page then says conveyor stopped although it runs; the publisher reads the primary webeverything checkout, 1795 commits behind. Fix: make the running-jobs read fit (filter to live rows before enrichment, longer limit), report unknown instead of stopped on a timed-out conveyor check, and read WE state from an up-to-date checkout. Source: the WIP design note from the 2026-10-02 design pass.

## Progress

Premise checked against the current code and a live timing run (2026-10-03, load average ~17).

- **Old scope:** `we:scripts/operations/agent-activity.mjs` and `we:scripts/operations/live-state.mjs`. **Corrected:** both are pure files with no reads. The slow reads live in their IO shells, `we:scripts/operations/live-state-io.mjs` and `we:scripts/operations/agent-activity-io.mjs`. Scope now names those two plus their test files.
- **Old premise:** the running-jobs read is slow because rows are enriched before filtering. **Measured:** the "running-jobs read" is Plateau's one call to the `live-state` operation (`plateau-app:src/wip/wip-read.ts:250 (readLiveStateVerdict)`, `timeout: 30_000` at line 254). Live timings of its parts:
  - WE lane-pool status (`we:scripts/lane-pool.mjs` `status --json`): **~15.3s, and it runs twice.** Once for the lanes section (`we:scripts/operations/live-state-io.mjs:89 (readAllLanePools)` → `we:scripts/operations/live-state-io.mjs:69 (readOneLanePool)`), and again for the lease join inside the activity reader (`we:scripts/operations/agent-activity-io.mjs:128 (readLaneLeases)`, called at `we:scripts/operations/agent-activity-io.mjs:259`).
  - All three lane pools together: ~23s. Daemons: ~1.2s. Activity reader without leases: ~1–10s (noisy under load).
  - Subagent rows: 543 rows for 15 live sessions, of which only 24 had a transcript write in the last 6h. Each row reads up to 1 MB of its transcript head (`we:scripts/operations/agent-activity-io.mjs:171` and `:181`, `firstMessageText`) before any filter.
  - So the biggest win is reading the WE lane-pool status once, not twice (~15s saved). Filtering subagents to recent ones before reading them is the card's "filter to live rows before enrichment"; it is a smaller win.
- **Conveyor check: the WE side is already honest.** `we:scripts/operations/runner-activity-io.mjs:72` documents #3884: a `ps`/`lsof` timeout fails the read; it never reads as dead. The `runner-activity` operation took 1.1s live. The "conveyor stopped" text comes from Plateau. `plateau-app:src/wip/wip-read.ts:418` falls back to every daemon `absent` when the read throws (it does mark `runner` degraded). Then `plateau-app:src/wip/wip-view.ts:458` prints "conveyor stopped" whenever the dispatcher is not `running`, and ignores the degraded flag. That is cross-repo → Follow-up.
- **Stale checkout: Plateau side.** `plateau-app:scripts/wip-publish.ts:42` and `plateau-app:scripts/wip-snapshot.ts:10` default `WE_ROOT` to the primary webeverything checkout. Measured now: 2100 commits behind `origin/main`. Cross-repo → Follow-up.
- **"Longer limit"** is the 30s `timeout` at `plateau-app:src/wip/wip-read.ts:254`. Cross-repo → Follow-up.

This card stays WE-only: make the `live-state` read itself fast enough.

### Implementation and proof — 2026-10-03

- Implemented only the four scoped files. The WE status read now supplies both lane counts and activity leases; a failed shared read stays an error row and an empty lease join without a retry. Only `live-state` enables the existing six-hour cutoff, before opening plain or workflow subagent transcripts. Other activity-reader defaults remain unchanged.
- Regression first: the new tests failed against the original implementation (missing count/projection exports, missing shared-status options, and stale transcripts retained). The final focused command, `npx vitest run we:scripts/operations/__tests__/live-state-io we:scripts/operations/__tests__/agent-activity-io-real` (remove the locus prefixes when executing), passes **40 tests in 3 files**, including the existing live-state real-IO suite.
- Repeat/soak proof: 20 successful-status reads plus 20 failed-status reads each obtain exactly one WE status, pass that same result to lane counts and leases, and enable precisely `RECENT_MS`. Real filesystem fixtures cover plain and workflow children, fresh/stale/exact-boundary timestamps, stat failures, unfiltered defaults, and injected lease joining without spawning. A real Node child observes native file opens: four fresh/boundary heads, zero stale heads, and zero opens on stat failure.
- Live timing: ran `node we:scripts/operations/run.mjs live-state --json` (remove the locus prefix when executing) three times on this checkout's unmodified **main at 31d7c51a87f476526b29e97fdb1df7a1e93a3b02**, then three times with the implementation. JSON verdicts were retained as temporary before/after data, with no helper files. **Before: 31.223s / 30.936s / 37.844s; after: 28.000s / 29.858s / 30.863s.** Mean 33.335s → 29.574s (3.761s lower). One-minute load was 13.7–15.8 before and 17.7–25.8 after, with verification also running during the after samples: this is observed latency, not an isolated attribution of the speedup. **The third after run still exceeds Plateau's 30s limit.** The cross-repo timeout follow-up remains necessary.
- Live spawn probe: instrumented native subprocess calls in memory while executing the actual CLI. Before: loaded the original collector from HEAD in memory and observed **two WE status spawns, four pool spawns total**. After: **one WE status spawn without a repo argument, three pool spawns total**. No live subagent heads were opened; this host sample has no matching live subagents, so stale-head exclusion is demonstrated by the real fixture above rather than claimed from an empty live sample.
- Verdict comparison: all three pairs retain exactly the same **17 running-row IDs**, with none added or removed. The live lane sections are not byte-identical: WE changed from 74 free / 8 leased, then 75 / 7, to 76 / 6; dirty stayed 12 and both sibling counts stayed unchanged. Concurrent live observations therefore cannot establish identical lane counts; the regression feeds identical status to both counting paths and requires equal output. Additionally, replaying each captured live pool status through the HEAD counter and the new counter produced identical counts for **WE (both reads), frontierui, and plateau-app**.

- Final wider verification: `node we:scripts/verify-lane.mjs` (remove the locus prefix when executing) passed **2,984 tests across 67 files**, then full `npm run check:standards` passed with **0 errors** (5,290 warnings). The earlier wider run caught the new native-open observation fixture; it was corrected to use a real Node child, preserving every open-count assertion. `git diff --check` also passed.

## Design

Two changes, both in the IO shells. No pure file and no verdict shape changes.

1. **One WE lane-pool status read per `live-state` call.**
   - In `we:scripts/operations/live-state-io.mjs`, split `readOneLanePool` (line 69) in two:
     - `readLanePoolStatus(repoKey, { execFn, cwd, repoPathArg })` → `{ parsed }` on success, `{ error }` on failure. It does the subprocess call and `JSON.parse`, with the same args and 60s timeout as today.
     - `countLanePool(repoKey, status)` → the same `{ repoKey, total, free, leased, dirty }` row (or the same error row) as today. Pure.
     - `readOneLanePool` keeps its signature and becomes `countLanePool(repoKey, readLanePoolStatus(repoKey, o))`. Existing tests stay green.
   - `readAllLanePools({ execFn, home, statusFor = {} })`: when `statusFor[repoKey]` is given, count it instead of spawning.
   - In `we:scripts/operations/agent-activity-io.mjs`, export a pure `leasesFromLanePoolStatus(parsed)` (the `lanes.map(l => l.lease).filter(Boolean)` step now inside `readLaneLeases`, line 135). `readLaneLeases` uses it. A missing or bad `parsed` gives `[]`, same as today's fail-soft.
   - `createAgentActivityReader` (line 246) gains `readLeases = () => readLaneLeases({ run, root })`. Line 259 calls `readLeases()` instead of `readLaneLeases(...)`. Default behaviour is unchanged for the `agent-activity`, `item-activity` and `live-work` operations.
   - `collectLiveState` (`we:scripts/operations/live-state-io.mjs:130`) gains two seams: `readWeLaneStatus = () => readLanePoolStatus('we', { cwd: ROOT })` and `createActivityReader = createAgentActivityReader`. The `readActivity` default becomes `undefined`. In the body: call `readWeLaneStatus()` once. Pass `{ statusFor: { we: weStatus } }` to `readLanes`. If no `readActivity` was injected, build one with `createActivityReader({ readLeases: () => leasesFromLanePoolStatus(weStatus.parsed), subagentRecentMs: RECENT_MS })`. An injected `readLanes`/`readActivity` (the existing test) still works; `readLanes` just ignores the extra arg.

2. **Filter subagents to recent ones before reading them.**
   - Export the existing `RECENT_MS` (6h, `we:scripts/operations/agent-activity-io.mjs:208`, already the interactive-session window). No new threshold.
   - `subagentRowsFor(parentSessionId, cwd, projectsDir, { recentMs = null, now = Date.now(), stat = statSync } = {})`: when `recentMs` is a number, `stat` each subagent transcript first and skip it when `now - mtimeMs > recentMs` or the stat fails. The skip happens before `firstMessageText`. With `recentMs` null (the default) nothing changes.
   - `createAgentActivityReader` gains `subagentRecentMs = null` and passes `{ recentMs: subagentRecentMs, now: now() }` at line 287. Only `live-state` turns it on. So the `agent-activity`/`item-activity` card joins are unchanged.

Why only `live-state` gets the filter: the card names the /wip running-jobs read. Changing what `agent-activity` joins to cards is a separate call nobody asked for. Both changes are the simplest tactic that keeps every other caller's behaviour fixed.

## MVP

Both changes above. Nothing in Plateau. No new operation, no new constant.

## Test plan

Runner: vitest (both files import from `vitest`).

In `we:scripts/operations/__tests__/live-state-io.test.mjs`:
- `countLanePool counts a pre-read status the same as readOneLanePool` — same fixture as the existing "splits existing lanes" case, fed as `{ parsed }`; expect `{ repoKey: 'we', total: 3, free: 1, leased: 1, dirty: 1 }`. And `{ error: 'boom' }` → an error row with `free: 0`.
- `readAllLanePools uses a given statusFor.we instead of spawning for we` — fake `execFn` records calls. Expect 2 calls (frontierui, plateau-app only), and the `we` row counted from the given status.
- `collectLiveState reads the WE lane-pool status exactly once and feeds both the lanes section and the lease join` — inject `readWeLaneStatus` (counts calls, returns `{ parsed: { lanes: [{ exists: true, clean: true, leased: true, lease: { purpose: 'build-1', ownerSession: 's1' } }] } }`), a `readLanes` that records its arg, and a `createActivityReader` fake that records its options, calls `readLeases()`, and returns `{ rows: [] }`. Expect: `readWeLaneStatus` called once; `readLanes` got `statusFor.we` equal to that status; `readLeases()` returned `[{ purpose: 'build-1', ownerSession: 's1' }]`; `subagentRecentMs` equals the exported `RECENT_MS`.

In `we:scripts/operations/__tests__/agent-activity-io-real.test.mjs` (real dir tree; `utimesSync` is already imported):
- `subagentRowsFor with recentMs skips a stale subagent transcript and keeps a fresh one` — two real subagent transcripts, one with mtime 7h ago. With `{ recentMs: RECENT_MS, now }` → only the fresh row. Without options → both rows (no change).
- `createAgentActivityReader uses an injected readLeases and never spawns lane-pool` — inject `listAgents` returning one live session, a `run` that throws if called, and `readLeases` returning a lease whose `ownerSession` matches. Expect the row's `lease` to be that lease.
- `leasesFromLanePoolStatus returns [] for a missing or malformed status` — `undefined`, `{}`, `{ lanes: 'x' }` → `[]`.

## Proof plan

Live case: the `live-state` read /wip makes, timed on this machine.

- **Before** (recorded 2026-10-03, load ~17): WE lane-pool status 15.3s, run twice; all three pools ~23s; whole read ~40s. Re-measure on main: time the `live-state` operation with `--json` redirected to a scratch "before" file, three runs.
- **After:** same command on the built lane, three runs. Expect about one WE lane-pool read (~15s) less per run. Count spawns directly (a temporary wrapper or `NODE_DEBUG=child_process`): exactly one WE lane-pool `status --json` with no `--repo`.
- **Same answer:** diff the before and after verdicts. `sections.lanes` must match. `running` must keep every non-subagent row. Subagent rows drop only those with no write in 6h (live count 2026-10-03: 543 → 24).
- Report the before/after seconds on the PR. If "after" is still over 30s under load, say so plainly; the Plateau timeout Follow-up then carries the rest.

## Done when

1. **Executable** — `npx vitest run scripts/operations/__tests__/live-state-io scripts/operations/__tests__/agent-activity-io-real` passes. It fails before this change, because the new cases in `we:scripts/operations/__tests__/live-state-io.test.mjs` and `we:scripts/operations/__tests__/agent-activity-io-real.test.mjs` use seams that do not exist yet (`countLanePool`, `statusFor`, `readWeLaneStatus`, `createActivityReader`, `readLeases`, `recentMs`, `leasesFromLanePoolStatus`).
2. One `live-state` read spawns the WE lane-pool status exactly once (it was twice).
3. `live-state` reads no subagent transcript head for a subagent with no write in the last 6h.
4. The `agent-activity`, `item-activity` and `live-work` operations behave as before: their defaults read leases and subagents exactly as today.
5. The Proof plan's before/after timings are on the PR.

## Follow-ups

Cross-repo, in plateau-app. Out of this WE-only card. File them as plateau-app items:

- **Unknown, not stopped.** `plateau-app:src/wip/wip-view.ts:458` prints "conveyor stopped" when the dispatcher is not `running`. It must check whether `runner` is in the snapshot's `degraded` list (set at `plateau-app:src/wip/wip-read.ts:418`) and show "conveyor unknown" in that case.
- **Up-to-date WE checkout.** `plateau-app:scripts/wip-publish.ts:42` and `plateau-app:scripts/wip-snapshot.ts:10` default `WE_ROOT` to the primary checkout (2100 commits behind on 2026-10-03). Point the default at a checkout kept on `origin/main`, or fetch before reading.
- **Longer limit.** `plateau-app:src/wip/wip-read.ts:254` cuts `live-state` at 30s. Raise it to fit the measured "after" time with headroom, once this card's numbers are in.

Testing follow-ups from this implementation (no shared agent docs changed): native filesystem timestamp round-trips can lose a fraction of a millisecond; use whole-second fixture timestamps to exercise the exact cutoff without relaxing it. Native ESM open instrumentation is exercised in a real Node child before importing the reader, keeping the actual filesystem operations and avoiding test-loader binding differences.
