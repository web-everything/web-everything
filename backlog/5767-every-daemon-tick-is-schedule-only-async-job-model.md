---
bornAs: xz2yynk
kind: epic
parent: "4075"
status: open
dateOpened: "2026-10-10"
tags: []
---

# Every daemon tick is schedule-only (async job model)

Held item 201 (operator 2026-10-10: "All daemons"; design settled 2026-10-10, revision 3 after two jury rounds; operator option (a) after jury round 2 cut the scope to the fixer speed-up under today's single lease holder, and moved blue-green to its own later design). Every daemon tick checks its lease, reads one shared view (the PR snapshot we:scripts/lib/pr-snapshot.mjs and the pr-facts store), reattaches existing tasks, schedules one bounded per-item task on the job core (cap through the policy cascade, per-daemon mode inline|shadow|tasks), collects results and returns in under 15 s; nothing slow runs inline. A per-PR task runs read -> plan -> claim -> (per effect: probe -> fence -> act -> mark). Already done: health probes #4691, rebuild+smoke #4731, verify gates #4764, drain after-merge #4761.

## Decision record (settled context; re-open only with new evidence)

- R1 slow actions are detached jobs with run-store records and a host:pid:procStart handle; writers to main are serial with no unlocked fallback (operator 2026-09-25, #4120, we:docs/agent/platform-decisions.md#daemon-jobs).
- R2 job records live under ~/.claude/daemon-jobs/<daemon>/ (#4125).
- R3 reload is a clean exit between ticks (#3681); unchanged here.
- R4 exactly one writer to main, the drain; the drain lease (we:scripts/readiness/drain-lock.mjs) is not touched (operator 2026-07-27, #2692).
- R5 E1-E7: decide per PR across all roles; executors per role; shadow, then flip per role (operator 2026-10-08, #5452).
- R7 every setting goes through the cascade, source layer logged (#5600, we:scripts/lib/policy-cascade.mjs). R8 admission through the one shared service (we:scripts/lib/resource-admission.mjs).
- R13 the fix claim is the per-PR lock. R14 only the role holding a worker's run record resumes it. R15 scope cut (operator 2026-10-10, after jury round 2, option a).
- Ruled forks: O1 plan and act under the claim with a live fence; O2 one task per PR across roles (E1); O3 no reuse key in this design; O4 build tasks now, shaped as the E2 executor; O11 timeout lives in the job core; O13 a review claim blocks only review and a fix claim blocks review; O14 acting concurrency 1 per repo until measured, then raised through the cascade; O15 a claim whose owner cannot be confirmed gone is quarantined with a health episode, never released on TTL.

## Evidence (live logs 2026-10-10)

- Fixer passes 1514 / 1771 / 2322 s; planning is 97-98% of each pass; every PR is planned 4x (fix, ci-heal, promote-draft, notes) and git fetch runs 3x per repo.
- Reviewer cold first tick 9-12.5 min after each restart. Builder ticks 236-546 s.
- Drain numbering and land locks fall back to running unlocked on contention (breaks R1). Pass daemons and runner passes have no timeout.

## Slices and order

S1 (x7cvrkd, item 200, built in lane-17) || S2a || L1 || S6a -> W1 -> S3 shadow -> S3t (the fixer win) -> S4 reviewer -> S5 builder -> S6b drain -> S9 pass daemons -> optional S6, S7, S8. Each slice card carries its required crash/seam tests (jury round 2 findings J2-0..J2-24 mapped to tests); the 8 blue-green findings moved to the sibling blue-green epic.

Slice cards: S1 = x7cvrkd; S2a = 5754; L1 = 5762; S6a = 5745; W1 = 5757; S3 = 5759; S3t = 5765; S4 = 5763; S5 = 5764; S6b = 5749 (also held item 203); S9 = 5755; optional S6 = 5756, S7 = 5760, S8 = 5741 (filed unqueued).
Sibling epic: 5766 (Blue-green daemon hand-over).

## Acceptance

- [A1] **Executable** — every slice is resolved: S2a, L1, S6a, W1, S3, S3t, S4, S5, S6b, S9 (S1 is x7cvrkd). The optional S6, S7, S8 may be dropped by the operator.
- [A2] **Live** — fixer `tick-timing` under 15 s for 1 h and median decision latency under 3 min; reviewer first decision after a restart under 2 min; builder `timings.totalMs` under 30 000; no pass runs past its timeout.

## Non-goals

- [N1] Blue-green hand-over: the sibling epic 5766 "Blue-green daemon hand-over (separate design)".
- [N2] Any change to the drain lease (R4).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a at epic level: each slice card states its own handling.
2. **Truncated reads** — n/a at epic level: each slice card states its own handling.
3. **Shared state files** — n/a at epic level: each slice card states its own handling.
4. **Fail closed** — n/a at epic level: each slice card states its own handling.
5. **Identity scoping** — n/a at epic level: each slice card states its own handling.
6. **State over time** — n/a at epic level: each slice card states its own handling.
7. **Who wrote it** — n/a at epic level: each slice card states its own handling.
