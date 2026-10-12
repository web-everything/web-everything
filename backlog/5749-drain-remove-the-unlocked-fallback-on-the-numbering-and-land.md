---
bornAs: xjuobaq
kind: story
size: 2
parent: "5767"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/readiness/drain-lock.mjs", "we:scripts/lib/daemon-self-sync.mjs", "we:scripts/lib/daemon-clone-lock.mjs", "we:scripts/pr-land.mjs", "we:scripts/lib/number-pending-hashes-before-push.mjs"]
dateOpened: "2026-10-10"
preparedDate: "2026-10-12"
preparedAgainstSha: "003fe207938f566474742a3e00718b370ffd1b50"
tags: []
---

# Drain: remove the unlocked fallback on the numbering and land locks

Slice S6b of the async-daemons epic; also held item 203 (found by the async-daemons design pass; counts as a safety fix). Drain numbering and merge locks fall back to running UNLOCKED when contended, violating the jobs statute's "no unlocked fallback" (R1). Design read at b2ef34324: we:scripts/merge-ai-prs.mjs:5953 and :6203; on fc8662311 the land-write mutex prints "merge-write mutex not acquired ... merged under the per-PR idempotency guard instead" (:5979) and the numbering lock is at :6151. Fix: a contended lock waits with a bounded budget (cascade setting) then defers the pass (logged); it never runs unlocked. Also check (item 203): `withSelfSync` never renews its clone-lock reader slot (we:scripts/lib/daemon-self-sync.mjs), so a tick over 10 min may lose it (untested).

## Acceptance

- [A1] **Executable** — a contended lock waits or defers; it never runs unlocked (R1).
- [A2] **Test (a)** — two landers contend: exactly one runs, the other defers.
- [A3] **Test (b)** — kill the holder mid-numbering: the next run recovers without double numbering.
- [A4] **Test (c)** — a tick longer than the reader-slot TTL keeps (renews) its clone-lock reader slot, or the gap is shown not to exist.
- [A5] **Live** — a `deferred: numbering-lock-held` line, and no unlocked run in 24 h.

## Non-goals

- [N1] The drain lease itself (R4).

## Progress

- Premise check (2026-10-12, main 003fe2079): NOT delivered. `git log` for 5749 / xjuobaq shows only the JIT-numbering commit 75be239bf. The default `runUnlockedOnContention = true` is still live in `withNumberingLock` (`we:scripts/readiness/drain-lock.mjs:210`), and xuqk1vp opted only `we:scripts/lane-drain.mjs` out of it.
- Citation drift (corrected): the card's old merge-ai-prs line numbers (5953, 6203, 5979, 6151) have moved. Now: land lock `we:scripts/merge-ai-prs.mjs:6411-6425` (message at :6425), numbering lock `:6599`, its unlocked message `:6689`.
- Scope drift: two more unlocked callers exist outside the card's scope: `we:scripts/pr-land.mjs:1386-1393` (break-glass land) and `we:scripts/drain-followup-job.mjs:16-20` (passes `withNumberingLock` as an injected dep; `we:scripts/lib/drain-followup-job.mjs` consumes it). The follow-up job files already pass `runUnlockedOnContention: false` (`we:scripts/lib/drain-followup-job.mjs:137`), so they stay out of scope. A third caller needs a fix: `we:scripts/lib/number-pending-hashes-before-push.mjs:66`. Scope widened to add `we:scripts/pr-land.mjs`, `we:scripts/lib/daemon-clone-lock.mjs` and `we:scripts/lib/number-pending-hashes-before-push.mjs`. `size` stays 2 (small edits at each call site, plus three tests).
- Item 203 confirmed real: `withSelfSync` calls bare `acquireRead` (`we:scripts/lib/daemon-self-sync.mjs:967`) and awaits the tick (`:1022`) with no heartbeat. Only `withReadLock` (`we:scripts/lib/daemon-clone-lock.mjs:590-604`) runs the `setInterval` heartbeat, and `withSelfSync` does not use it. A tick longer than the clone-lock lease (`DEFAULT_LEASE_MINUTES = 10`, `we:scripts/lib/daemon-clone-lock.mjs:59`) lets a writer reclaim the slot mid-tick.

## Design

**Lock contract.** In `withNumberingLock` (`we:scripts/readiness/drain-lock.mjs:210`) flip the default of `runUnlockedOnContention` to `false`. `withLandWriteLock` inherits it. The existing refusal return (`ran:false, contended:true, heldBy`) at `:233` is the defer signal; `lockResultOr` (`:276`) is the safe reader. `withPocLandLock` already passes `false` explicitly, so it is unchanged. The `runUnlockedOnContention: true` opt-in is removed; no caller may request it.

**Wait budget from the cascade.** `waitMs` currently defaults to a full lease (5 min) and blocks the thread (`sleepSyncMs`). Add a `resolveNumberingLockWaitMs(env)` helper in `we:scripts/readiness/drain-lock.mjs` (new env knob `WE_DRAIN_NUMBERING_LOCK_WAIT_MS`, non-negative integer, default 60 000 ms, same env-resolver shape as `resolveReaderPriorityAfter` in `we:scripts/lib/daemon-clone-lock.mjs:109`) and use it as the `waitMs` default inside `withNumberingLock`, so every call site gets the bounded wait without passing it. Past the budget the section is deferred, not run.

**Call sites** (each handles `ran:false`):
- `we:scripts/merge-ai-prs.mjs:6411` land write: already has the `ran === false` branch (`:6424`) for the enqueue case. Make it unconditional: drop the enqueue-only `runUnlockedOnContention: false` ternary, drop the "merged under the per-PR idempotency guard instead" path at `:6425` (the idempotency recheck stays as a backstop, no longer the fallback), and mark the candidate `skip` so it is retried next pass.
- `we:scripts/merge-ai-prs.mjs:6599` numbering: on `ran:false` leave `numbered` at its empty default, log `deferred: numbering-lock-held (held by <heldBy>) — pass deferred, retried next pass`, and record every landed id in `resolveOnLandReport.deferred` (the #2899 totality bucket), so no landed id is silently dropped. Delete the "numbered without it" line at `:6689`.
- `we:scripts/pr-land.mjs:1386`: on `ran:false` print the deferral and exit non-zero without pushing main (the merge already happened; the next drain numbers it). It must not call `gitPushMain`.
- `we:scripts/lib/number-pending-hashes-before-push.mjs:66-68`: calls `withNumberingLock` with default options, then reads `lock.result.error` — after the flip `result` is undefined on contention and this throws a TypeError. Fix: on `!lock.ran` return `{ attempted: true, error: 'numbering-lock-held' }`.
- `we:scripts/lib/drain-followup-job.mjs:137-141` already passes `runUnlockedOnContention: false` and throws on `!lock.ran`; `we:scripts/drain-followup-job.mjs` only injects the function; `we:scripts/lane-pool.mjs:125` is a comment. All three need no change (reviewed, not in scope).
- `we:scripts/merge-ai-prs.mjs:6688` `numbered = numLock.result` is undefined on refusal and `numbered.assigned` is read later (`:6777`): guard it with `lockResultOr(numLock, numbered)` so the empty default survives.

**Killed holder (test b).** Already handled by `reserve` with the pid-dead probe (`probeNumberingHolderLiveness`, `we:scripts/readiness/drain-lock.mjs:98`): a dead same-host pid is reclaimed on the first poll. The new test pins it end to end: numbering restarted after a killed holder numbers each hash exactly once (`numberPendingHashes` is idempotent on a re-run, so a half-done rename is finished, not repeated).

**Reader-slot renewal (item 203).** Replace the bare `acquireRead`/`releaseOnce` pair in `withSelfSync` with a heartbeat started right after acquire: a `setInterval` (`HEARTBEAT_INTERVAL_MS`, `.unref()`'d) calling `heartbeat(readersRoot, owner, owner, now, pid)` against `cloneLockDirs(root, ...)`. Export a small `startReaderHeartbeat(root, opts)` returning a `stop()` from `we:scripts/lib/daemon-clone-lock.mjs`, reuse it in `withReadLock` (single source), and call `stop()` inside `releaseOnce`. Never fork the heartbeat code.

## MVP

Musts only:
1. Default `runUnlockedOnContention` to `false`; remove the unlocked paths at `we:scripts/merge-ai-prs.mjs:6425`, `we:scripts/merge-ai-prs.mjs:6689`, `we:scripts/pr-land.mjs:1393`.
2. Bounded wait from the cascade, then `deferred: numbering-lock-held` log and defer the pass.
3. Every caller reads the lock outcome through `ran` / `lockResultOr`: `we:scripts/merge-ai-prs.mjs:6688`, `we:scripts/pr-land.mjs:1386`, and `we:scripts/lib/number-pending-hashes-before-push.mjs:66`.
4. `startReaderHeartbeat` shared with `withReadLock`, started by `withSelfSync` for the tick's duration.
5. Tests (a), (b), (c) below.

OUT of scope (see Follow-ups): the drain lease itself (N1); separate keys for the land and numbering locks; changing the lock TTLs; an async (non-thread-blocking) wait.

## Edge cases this change must handle

1. **Untrusted text** — n/a: lock files hold only daemon-written `host:pid:kind` owner ids; `heldBy` is folded into a log line only, never passed to a shell or argv.
2. **Truncated reads** — an unreadable or half-written lock entry counts as held; `reserve` must not read it as "free". Test: a lock dir with a corrupt entry defers (`ran:false`) rather than runs. A `heldBy` of `null` still defers.
3. **Shared state files** — numbering and land stay ONE key (`NUMBERING_LOCK_PATH`), so merge and numbering stay mutually exclusive. The wait budget comes from the cascade, not a literal. The reader heartbeat writes through `heartbeat()` (atomic, fenced by owner), never a raw write.
4. **Fail closed** — contention, a lock error, or a throw inside acquire all return `ran:false` and defer; `fn` is never called. A `.result` of `undefined` is never read as "nothing to number".
5. **Identity scoping** — the owner is host + pid + kind; the heartbeat and release are fenced to that owner so a reclaimer's entry is never overwritten; only a provably dead same-host pid is reclaimed early (#4134 / xuqk1vp). A foreign-host owner is never probed.
6. **State over time** — a deferred pass retries next tick with no state written. A tick longer than the reader TTL keeps its slot via the heartbeat (test c). A holder killed mid-numbering is reclaimed and the re-run numbers each hash once (test b). The wait uses the injected `now`, not wall-clock arithmetic across processes.
7. **Who wrote it** — only the drain, the `pr-land` break-glass and the follow-up job write these locks; the owner kind tag is diagnostic only, trust comes from the lock key plus pid liveness, not the name.

## Test plan

In `we:scripts/readiness/__tests__/drain-lock.test.mjs` unless noted:
- **(a) contention** — two `withNumberingLock` callers on one `lockRoot` (injected `now`/`sleep`): the first holds, the second with a short `waitMs` gets `ran:false, contended:true, heldBy`, and its `fn` spy is never called. RED today: the default is `true`, so the second runs `fn` unlocked.
- **(a2) default is closed** — calling with no options on a held lock does not run `fn`; same for `withLandWriteLock`. RED today for the same reason.
- **(a3) corrupt entry** — an unparseable lock entry defers (`ran:false`, `fn` not called). RED today only through the default flip; it also pins that `reserve` never reads a corrupt entry as free.
- **(a4) call-site wiring** (`we:scripts/__tests__/merge-ai-prs-stranded-sweep-wiring.test.mjs` style, source-text/wiring assertions): the numbering block reads its outcome through `lockResultOr`, logs `deferred: numbering-lock-held`, and adds landed ids to `resolveOnLandReport.deferred`; `we:scripts/lib/number-pending-hashes-before-push.mjs` with a held lock returns `{attempted:true, error:'numbering-lock-held'}` instead of throwing (RED today: unlocked run, and a TypeError after a bare flip). The `we:scripts/pr-land.mjs` numbering is top-level script code with no `gitPushMain` seam, so its guard is asserted by a source-text check that the push sits behind `numLock.ran`.
- **(b) killed holder** — regression pin, GREEN today by design (reclaim is already built; it guards the new defer path against wedging a dead holder's section). Spawn a child that takes the lock and renames one of two pending hashes, then `SIGKILL` it. The next `withNumberingLock` reclaims on the pid-dead path with no TTL wait and ends with each hash numbered once and no duplicate NNN. It fails if a stale lock wedges the section or a re-run double-numbers.
- **(c) reader renewal** (`we:scripts/lib/__tests__/daemon-self-sync.test.mjs`): with fake timers and `leaseMinutes` shortened, run a tick longer than the lease; assert the reader entry's `heartbeatAt` advances and a competing `acquireWrite` is refused for the whole tick, then the slot is released. RED today: nothing heartbeats, so the writer reclaims the slot mid-tick.

## Proof plan

- **Before**: on current main, hold the numbering lock from a second process (`withNumberingLock` with a sleeping `fn`) and run the drain's numbering step; capture the `numbering mutex not acquired ... numbered without it` line and the unlocked run.
- **After**: same setup on the lane build; capture `deferred: numbering-lock-held` and no numbering commit, then release the holder and show the next pass numbers once.
- **Reader slot**: a CLI probe that runs a `withSelfSync` tick with `leaseMinutes` set to 3 (above the 60 s `HEARTBEAT_INTERVAL_MS`, so the heartbeat cannot race expiry) and a 7-minute simulated tick, printing the reader entry `heartbeatAt` before and after.
- **Live (A5)**: after landing, grep the drain log for `deferred: numbering-lock-held` and for the absence of `numbered without it` over 24 h.

## Follow-ups

- Split `withLandWriteLock` and the numbering lock onto separate keys only if the shared key shows real contention in the 24 h log.
- Replace the thread-blocking `sleepSyncMs` wait with an async wait in the drain.
- Add a tripwire that fails `check:standards` on any `runUnlockedOnContention: true`.
- Audit the remaining TTL leases (`DRAIN_LEASE_MINUTES`, POC land) for the same missing-renewal gap.
