---
bornAs: xle1sxo
kind: story
size: 3
status: open
dateOpened: "2026-10-24"
tags: []
---

# Lane-pool recovery is slow: about 1.5-2 min per lane, so an 8-minute budget recovers only a few lanes

Recovery (PR 5855) runs a reclaim dry-run subprocess, a bounded fetch and a salvage push per lane, one at a time. Measured live on the real 90-lane pool: salvage refs for lanes 6, 18, 25, 26, 30 landed 12:45 to 12:52 (about 1.5-2 min per lane), so the 8-minute budget recovers about 5 lanes while 79 need work. Suggested fixes: (1) batch the git transport: one fetch for the whole pool, one push with several refspecs, instead of a node subprocess per lane; (2) run recovery during the scheduled gc pass so an acquire that finds the pool full rarely has to recover inline; (3) bounded parallelism (3-4 lanes) for the per-lane proofs. Also card: remove ignored --dry-run (fixed in 5855).

## Acceptance

- [A1] **Executable** — Add the named test `recovers a 90-lane pool within the transport budget` to `we:scripts/lib/__tests__/lane-pool-recover.test.mjs` and run the recovery test command below. With injected 100 ms asynchronous transport latency per lane, recover all 90 eligible lanes in at most 6 seconds, with at most four in-flight lanes; the current serial implementation exceeds that bound. This is a planned performance test, not evidence that the optimization has shipped.
- [A2] **Must refuse** — `failed preservation never schedules a reset` must cover fetch, salvage verification, backup and liveness failures, including docs, config, data, stashes and untracked backlog cards.
- [A3] **Must isolate** — `parallel recovery rechecks leases before reset` must prove a lease acquired during recovery is kept and another lane's backup or remote proof cannot authorize its reset.

Run the recovery tests from the WE checkout:

```bash
npm run test:unit -- scripts/lib/__tests__/lane-pool-recover.test.mjs scripts/__tests__/lane-pool-recover-race.test.mjs
```

## Non-goals

- [N1] Do not raise the pool hard cap, relax preservation or liveness checks, force-push salvage refs, or change operator override semantics. Backup-format completeness is a separate follow-up.

## Edge cases this change must handle

1. **Untrusted text** — Keep Git arguments as argv; reject lane-config URL rewrites and unsafe backup paths. Test `parallel recovery retains transport hardening`.
2. **Truncated reads** — Buffer overflow, timeout or incomplete JSON refuses the affected lane; test `failed preservation never schedules a reset`.
3. **Shared state files** — Use per-attempt backup directories and existing exclusive lease transitions; test `parallel recovery rechecks leases before reset`.
4. **Fail closed** — Failed or incomplete preservation, backup or liveness evidence keeps the lane; test `failed preservation never schedules a reset`.
5. **Identity scoping** — Bind each result to pool, lane and canonical primary origin; test `parallel recovery retains transport hardening` across two pools with the same lane number.
6. **State over time** — Stop scheduling new work at the recovery deadline, wait for bounded in-flight work, and recheck leases before reset; test `deadline stops new work and accounts for in-flight lanes`.
7. **Who wrote it** — Lane config and content are untrusted; only canonical remote verification and verified operator backups permit reclaim. Test `parallel recovery retains transport hardening`.

## Risks

- R1: Parallel transport overloads the host or remote. A1 caps in-flight work at four; the deadline test must account for every lane exactly once.
- R2: A lease or content changes during a parallel proof. A2/A3 keep the lane when evidence changes or fails.
- R3: Batching shares proof or backup state across pools. The transport-hardening test must use distinct remotes and identical lane numbers.

## Test plan

These tests are requirements for the future performance change, not implemented by the preservation PR.

- R1 → `recovers a 90-lane pool within the transport budget` and `deadline stops new work and accounts for in-flight lanes` in `we:scripts/lib/__tests__/lane-pool-recover.test.mjs` (A1).
- R2 → `failed preservation never schedules a reset` and `parallel recovery rechecks leases before reset` in `we:scripts/__tests__/lane-pool-recover-race.test.mjs` (A2/A3).
- R3 → `parallel recovery retains transport hardening` in `we:scripts/__tests__/lane-pool-recover-race.test.mjs` (A2/A3).
- Capture a before/after 90-lane local-origin CLI benchmark, reporting eligible/reclaimed/kept/skipped counts and total duration. No HTTP endpoint is added; body size, CSRF and request rate limits do not apply. Existing host admission still applies.
