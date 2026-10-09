---
bornAs: xkqia1h
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/health-smells/pass-failing-repeatedly.mjs", "we:scripts/conveyor/health-smells/__tests__/pass-failing-repeatedly.test.mjs", "we:scripts/conveyor/health-watch-core.mjs", "we:scripts/operations/free-scope.mjs", "we:scripts/operations/__tests__/free-scope.test.mjs", "we:scripts/worker-brief.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Health smell pass-failing-repeatedly: raise [high] when a daemon pass keeps failing (2026-10-08 lease-reaper OOM, 92 crashes unseen)

On 2026-10-08 the lease reaper OOM-crashed every pass 08:37Z-15:57Z (92 crashes, nothing reaped) and the health-watch raised nothing. Add a generic smell: N consecutive failed passes or no successful pass in X minutes (both knobs) raises [high] naming the pass and the last error line. Also: free-scope must not flag a backlog/ folder scope as occupied just because open PRs add their own new card files.

## Done when

1. **Executable** — `npm run test:unit -- we:scripts/conveyor/health-smells/__tests__/pass-failing-repeatedly.test.mjs` fails before (no smell, no `passFailures` record) and passes after; replaying the real 2026-10-08 `lease-reaper.log` through the smell opens a `[high]` episode within ~20 min of the first crash and stays quiet on the healthy passes before and after.
2. **Free-scope** — `free-scope-cli check --files=...,we:backlog/` no longer reports `we:backlog/` OCCUPIED just because open PRs each add their own new card file; a PR editing an existing card the scope lists still reports OCCUPIED.

## Edge cases this change must handle

1. **Untrusted text** — log lines are only matched and quoted (capped at 200 chars) in a local alert; never executed.
2. **Truncated reads** — an error line and its exit line split across two reads: the alert falls back to the exit line itself.
3. **Shared state files** — the record lives in the health watch's own per-daemon memory (`state.daemons[name].passFailures`), written only by the health watch.
4. **Fail closed** — a bootstrap read (history of unknown age) drops unstamped failures instead of inventing a streak; stamped ones keep their own time.
5. **Identity scoping** — one subject per daemon log name; a pass's failures never count against another pass.
6. **State over time** — the record keeps 6 h / 200 entries; a failure-free stretch of `passFailingRecoverAfterMs` (stretched to 4 pass intervals) ends a streak.
7. **Who wrote it** — only `pass-daemon:` exit/spawn-failure lines and whole-tick failures count; a pass's own output that merely mentions "failed" does not.
