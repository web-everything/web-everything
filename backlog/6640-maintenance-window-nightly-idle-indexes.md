---
bornAs: xw8w02k
kind: epic
status: open
dateOpened: "2026-10-20"
tags: [maintenance, nightly, idle, index, run-store, git, tests, lane-pool, backlog, housekeeping, performance]
---

# Maintenance window + nightly/idle indexes

One load-aware maintenance-window job runs expensive full passes when the host is idle (quiet hours 22:00-07:00 ET and daytime idle gaps) and publishes versioned indexes with a watermark; daytime readers use index + delta-since-watermark and fall back to today's full read on any mismatch (fail closed). Six ordered slices: run-store index+archive, git upkeep, nightly test timings, lane pre-warm, backlog index, housekeeping.

Operator approved filing 2026-10-20 ("ok").

## Principle

- Do the expensive full pass when the host is idle: the quiet-hours window (default 22:00-07:00 America/New_York, already modelled by `we:scripts/lib/quiet-hours.mjs`) and daytime idle gaps (load and free memory under threshold).
- Each full pass publishes a **versioned index with a watermark** (the last write sequence or manifest entry it covered).
- Daytime readers use **index + delta since the watermark**. On ANY mismatch (unknown version, gap in the write sequence, manifest disagreement, index missing or older than its maximum age) they fall back to today's full read.
- **Fail closed. Never skip by metadata.** No reader may skip a file because its stat identity (size, mtime, inode) looks unchanged. Four earlier run-store caches that did this were rejected by the Codex guard audit as WEAKENED (see 6786). Completeness must be provable from a writer-owned sequence or manifest, not inferred from file metadata.

## Scheduler

One maintenance-window job, not one cron per task:

- Settings live in the policy cascade (a new `we:scripts/settings/maintenance-window.json`, resolved like the other cascade settings, source of each value logged): windows (quiet hours + idle-gap rule), load threshold per core (reuse the `host.maxLoadPerCore` idea from `we:scripts/settings/host-overload.json`), free-memory floor, per-task `enabled`, per-task order and time budget.
- It **pauses** when load or memory pressure rises mid-task and resumes at the next safe point. A task that cannot pause is not started unless its estimated cost fits the remaining window.
- Each task run is logged with: task, start/end, outcome, what it published (index version + watermark), and the settings source for its enable flag and thresholds.
- `lane-pool gc` is already named as "the scheduled maintenance entrypoint" (`lanes.gc.schedule` in `we:scripts/settings/host-overload.json`). This job absorbs or calls it; it does not start a second scheduler beside it.

## Slices (in order)

Each slice records its measure-before baseline FIRST (see last section), then ships behind its per-task enable flag.

### 1. Review run store: nightly index + archive/compress old runs

- Problem: the shared run store (`runsDir()` in `we:scripts/operations/run-store.mjs`) holds about 144,551 run files, about 30 GB. The daytime red-team evidence read parses all ~6.5k `review-pr-*` runs (~1.57 GB) at about 9.1 s per call (measured in 6786).
- Nightly: build the per-op / per-PR index; archive and compress finished runs older than N days into a compacted archive the index still covers.
- Reader: index + files written after the watermark. Completeness is provable from a writer-owned write sequence or manifest. Any gap means full read.
- Mode: **prototype**, shadow-compare (index answer vs full read, logged, full read still wins) before any reader switches.
- Predicted scope: `we:scripts/operations/run-store.mjs`, a new index/archive module under `we:scripts/lib/`, the three evidence readers named in xwu9oxh, tests.
- Links, do not duplicate: this is the nightly/idle half of **xwu9oxh slice S4** (run-store retention) and builds on the writer-owned identity index of **6786**. Whichever lands first owns the index format; this slice only adds the window scheduling and archive pass.

### 2. Git upkeep on lanes + daemon clones

- Run `git maintenance` tasks (repack, commit-graph, gc, loose-objects) on lane clones and daemon clones inside the window only, one clone at a time, skipping any lane that is held or mid-verify.
- Motivation: on 2026-10-20 at 13:26:56Z the shared drain daemon log shows `red-main-hold: shared freeze unreadable: branch unreadable: spawnSync git ETIMEDOUT`, so the drain reported main red and landed nothing. Slow git on bloated clones turns into false red.
- Link, do not duplicate: **x6y717a (graduation plan, numbered 6635 at land) slice S01** sets `maintenance.auto=false` on pool and daemon clones (no background maintenance at random times). This slice is the other half: the same work, run on purpose in the window.
- Mode: **debug-safe** is plausible because `git maintenance` never changes refs or content. Decide when the slice starts; if unsure, **prototype**.
- Predicted scope: `we:scripts/lane-pool.mjs`, `we:scripts/lib/lane-repair.mjs`, the maintenance-window job, tests.

### 3. Tests: nightly full suite with timings, flake and slow detection

- Nightly full unit suite with per-test timings, recorded as a versioned timings index.
- Detect flaky tests (pass/fail across reruns) and slow tests (over budget) and file them.
- Daytime: related-test selection and shard balancing read the timings index; fall back to the full set when the index is missing or stale.
- Flag time-dependent tests: run once with a shifted clock across midnight ET. The 2026-10-20 midnight time bomb (fixed in PR #5736, "pin the ledger readiness replay clock") is the case to catch.
- Mode: **prototype**.
- Related, not duplicated: the scheduled non-blocking live suite (`we:.github/workflows/live-tests.yml`) covers live network tests, not the full unit suite; 5725 (speed up the 5 slowest test files) is a consumer of this slice's slow list. No existing nightly CI stress-test card was found.

### 4. Lane pre-warm

- During idle time keep N lanes reset to `origin/main` with dependencies installed, so `lane-pool acquire` hands out a ready lane.
- Never touch a held lane; N is a setting.
- Mode: **prototype**.
- Related: 4015 (cut per-lane write cost: copy-on-write node_modules) lowers the cost of each pre-warm; no existing lane pre-warm card was found.

### 5. Backlog index: nightly rebuild + event increments

- Nightly full rebuild of the backlog index; during the day apply increments from card write events, with the same watermark + fall-back rule.
- Feeds the backlog index data service in the xwu9oxh target architecture ("light decoupled data services").
- Mode: **prototype**.

### 6. Housekeeping

- Log rotation: the shared drain daemon log is 316,705 lines on 2026-10-20 (over the 300k threshold). Rotate and compress by size/age.
- Prune old `lane/*` branches and old run records (run records after slice 1's archive exists).
- Expire stale lock and reservation files whose holder is gone (liveness proven, never by age alone).
- Mode: per item, **debug** (rotation) or **PR** (pruning, expiry).
- Related: 6126 (nightly card-number rename batch) is another nightly job and should register as a task of this window instead of its own timer.

## Non-goals

- [N1] Live PR state. It stays event-driven through the PR store (xdk2pq6, 6520); a nightly index of PR state would be stale by design.
- [N2] No reader ever trusts an index without the watermark check; there is no "fast path without fall-back".
- [N3] No change to what any gate decides; only how fast it reads.

## Measure-before baselines (record now, before each slice)

1. Run store: file count and bytes per op; evidence-read wall time per call (p50/p95) and peak RSS; mergeCascade pass time.
2. Git: per clone `git count-objects -v` (loose objects, packs, size), `git status` / `rev-parse` wall time, count of git ETIMEDOUT lines per day in the drain and review logs.
3. Tests: full suite wall time, per-file timings, flake count over 5 reruns, daytime verify wall time.
4. Lanes: `lane-pool acquire` wall time from request to ready (p50/p95), share of acquires that run a deps install.
5. Backlog: wall time and RSS of a full backlog load in the busiest callers.
6. Housekeeping: log sizes and line counts, branch count, run-record count, stale lock/reservation count.

## Acceptance

- [A1] **Executable** — a maintenance-window status command lists every task with its enable flag, settings source, last run, outcome and published index version/watermark; each slice adds a test where a reader given a watermark gap or version mismatch performs the full read (fails before the slice, passes after).
- [A2] Each slice shows before/after numbers on the live host against its baseline above.
- [A3] Shadow compare for slices 1 and 5 shows zero disagreements over at least one week before readers switch.

## Edge cases this change must handle

1. **Untrusted text** — index entries are parsed as data with a schema check; a malformed entry invalidates the index (full read), never partially trusted.
2. **Truncated reads** — indexes are written to a temp file and renamed atomically; a truncated or unparsable index means full read.
3. **Shared state files** — one writer per index (the window job) with a lock; readers never write the index.
4. **Fail closed** — any mismatch (version, watermark gap, missing manifest entry, age) falls back to today's full read; never skip by metadata.
5. **Identity scoping** — indexes are keyed per repo and per store; one repo's index never answers for another.
6. **State over time** — indexes carry a maximum age; past it they are ignored. A pause mid-task leaves the previous index in force.
7. **Who wrote it** — each index records the job run id and code version that built it; an index from an unknown writer is ignored.
