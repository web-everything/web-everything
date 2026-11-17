---
kind: decision
size: 3
status: open
scope: ["we:scripts/settings/delivery-capacity.json"]
dateOpened: "2026-11-16"
preparedDate: "2026-11-16"
preparedAgainstSha: "51631f0e3fc7a8d49e3b8407a51bfbdaf0f9f472"
tags: []
---

# Re-tune every MacBook-era load and capacity limit for the Mac Studio (30 cores, 96 GB)

Operator 2026-11-16 19:45 ET: the open-PR cap is a soft limit already planned to go dynamic, and every load limit needs review now the daemons run on the Studio. Covers we:scripts/settings/review-concurrency.json, we:scripts/settings/delivery-capacity.json, we:scripts/lib/delivery-capacity.mjs and the host platform preferences.

## Measured: MacBook baseline vs Studio

| Signal | MacBook (rulings) | Studio (host-sampler, 2026-11-17T00:25Z+, 46 samples at 30 s, about 22 min) |
|---|---|---|
| Cores / RAM | 12 cores (R732), about 36-48 GB | 30 cores (`hw.ncpu`), 96 GiB (`hw.memsize`) |
| Load at the R915 revert | 45 (3.75 per core), CPU idle 11%, mem free 10.9 GB | load1 p50 8.0, p95 13.8, max 16.1 (0.27 per core at p50) |
| CPU busy | 89% | p50 20.5%, p95 42.1%, max 55.8% (`top -l 2`: 92% idle) |
| Memory | free 10.9 GB, swap 4.6 GB in the 2026-10-20 emergency | available p50 74 GB, free p50 49 GB, swap 0, compressed 0, pressure level 1, thermal 100% |

Caveat: the Studio window is short and was taken during light load, right after the move. The data proves the old limits are far too tight. It does not prove where the new ceiling is. Every default below is staged: apply the cores ratio now (30 / 12 = 2.5), then let measured idle and memory move it.

## Inventory (current value, source)

| Group | Key | Now | Source / ruling |
|---|---|---|---|
| Open PRs | `deliveryCapacity.openPrCap`, `openPrCapMode`, `softOverCapStarts`, `maxStartsPerCheck` | 18, soft, 2, 8 | the platform preferences file, R915 / R927 |
| Gate | `idleMinPct`, `memMinGb` | 15, 4 | R702, the orchestrator capacity-gate script |
| Reducer slot | one slot at idle < 15% if mem >= 4 GB and load <= 60 | 60 | R761, the orchestrator capacity-gate script line 59 |
| Workers | worker cap by load band (L<24 -> 8, 24-35 -> 5, >=36 -> 0; 10 when L<24 and open PRs <= 12) | 10 ceiling | R349, R702 era; the session-setup prompts |
| Session-setup | tests allowed at L<48, load-explain at L>=36, refill at L<36 | 48 / 36 / 36 | R655, the session-setup prompts |
| Heavy admission | `heavyAdmission.cap`, `fastSlots`, `remote.maxConcurrent`, `remote.loadPerCoreThreshold` | 4, 2, 16, 1 | the platform preferences file |
| Host | `host.maxLoadPerCore`, `minMemoryHeadroomMb` | 9, 512 (reverted 2026-11-13, R915 revert rule: re-raise only when idle > 25% and mem free > 30% for 30 min) | the platform preferences file |
| Reviews | `maxLiveReviewRounds` | 3 (EMERGENCY 2026-10-20 at 114 MB free) | we:scripts/settings/review-concurrency.json |
| Red team / fix | red-team queue capacity 5 (R915); `fixCap` reverted (note only) | 5 / reverted | the platform preferences file, rulings R915 |
| Merge queue | `concurrency.gateReads`, `enqueue` | 6, 3 | we:scripts/settings/merge-queue.json |
| Lane pool | provisioned lanes; `acquire` grows by 4 up to hard max 90 | 15 | we:scripts/lane-pool.mjs |
| Auto-tune | `autoTune` units 12-48, mode shadow | shadow | we:scripts/settings/delivery-capacity.json |

Existing cards, not duplicated here: [8294](/backlog/8294-delivery-capacity-settings-r927-need-a-product-home-with-the/) (product home for these keys), [8324](/backlog/8324-delivery-capacity-setting-weighted-load-units-stuck-sub-cap/) (weighted units plus AIMD auto-tune = the planned dynamic open-PR cap), [8387](/backlog/8387-capacity-gate-should-use-delivery-signals-not-just-idle-cpu/) (gate on delivery signals). This card sets the Studio values those cards will tune from. It builds no code.

### Recommended path at a glance

| Fork | Group | Default |
|---|---|---|
| A | Open-PR cap | static soft cap 18 -> 30 now; 8324 AIMD then drives it |
| B | Review / red-team / fix concurrency | `maxLiveReviewRounds` 3 -> 8, red-team queue 5 -> 8, fix cap re-raised under the R915 rule |
| C | Gate and worker thresholds | scale load numbers by 2.5; `memMinGb` 4 -> 12; worker ceiling 10 -> 16 |
| D | Heavy admission and host | heavy cap 4 -> 8, fastSlots 2 -> 4, `minMemoryHeadroomMb` 512 -> 8192, keep `maxLoadPerCore` 9 |
| E | Lane pool | no change (15 lanes, grows on demand to 90) |

## Supported by default (not forks)

- `idleMinPct` 15 stays: a percentage already scales with core count. It is the primary gate (R702); load average stays secondary.
- `remote.maxConcurrent` 16 stays: it limits Forge jobs, not the Studio.
- merge-queue `gateReads` 6 / `enqueue` 3 stay: bounded by GitHub API rate, not host load.
- Every raise keeps the R915 revert rule (revert when idle < 25% or mem free < 30% for 30 min) and is applied by the orchestrator in steps, not at once.

## Fork A: open-PR cap (18, soft, +2 over-cap starts)

Fork-existence: a single number must be chosen; 18 is the MacBook value (R915 applied it because merges stalled and red-team capacity was 5), so keeping it on a 2.5x host would idle the machine.
- A1: keep 18 until AIMD (8324) ships. Safe, wastes the Studio.
- A2 (default): static cap 30, `softOverCapStarts` 4, `maxStartsPerCheck` 8 -> 12 now; 8324's shadow auto-tune (units 12-48) takes over and the R915 raise rule (merge rate >= 2/h, red-team free slots, fix pass < 30 min) becomes the dynamic brake.
- A3: cap 45 at once. Blocked by review and red-team concurrency (Fork B), so extra PRs just queue.
Why A2: the PR cap is bound by Fork B's seats, not CPU. 30 is ~1.7x, matching a review seat increase of 2.7x with margin for conflicts.
Skeptic: A2 wrong if merge conflicts scale faster than the cap; mitigated by the soft mode and the R915 drop-back rule. Survives.
Screen: single-axis numeric choice, no layering or naming confusion.

## Fork B: review, red-team and fix concurrency

Fork-existence: `maxLiveReviewRounds` 3 is an emergency from 114 MB free; the file's own revert condition says to raise it once host admission is memory-aware. The Studio has 74 GB available, so leaving 3 is the broken branch.
- B1: 3 -> 5. Cautious.
- B2 (default): 3 -> 8, red-team queue 5 -> 8, fix cap back to the pre-revert value only when the R915 revert rule's conditions hold (idle > 25%, mem free > 30%: true now, p50 idle 79%, free 51%).
- B3: remove the cap. Loses the guard against a repeat of the 12 GB review-process pile-up.
Why B2: 23 review processes were about 12 GB (about 0.5 GB each), so 8 rounds is about 4-8 GB of 96. CPU is not the limit.
Skeptic: B2 wrong if model API quotas, not the host, bind. Then more seats only queue at the provider; the cap is easy to lower. Survives.
Screen: no confusion; one setting file.

## Fork C: gate and worker thresholds

Fork-existence: the load numbers (36, 48, 60, 24) were calibrated on 12 cores; load is not comparable across core counts, so reusing them is wrong, and dropping load entirely loses the secondary signal.
- C1: leave all as is. Studio at load 8 is far under every number, so it never binds; harmless but it also never protects.
- C2 (default): scale by 2.5: L<24 -> L<60, L<36 -> L<90, tests L<48 -> L<120, load-explain L>=36 -> L>=90, reducer slot load <= 60 -> <= 150; `memMinGb` 4 -> 12 (same 4% of RAM is 4 GB; 12 is about 12%); worker ceiling 10 -> 16 (same 0.8 per core x 2.5 would be 25; 16 until measured).
- C3: drop load, use idle and memory only. Cleaner, but loses the load-explain trigger; 8387 may do this later.
Skeptic: scaling by cores is crude (Studio cores may be faster, so it errs safe). Survives.
Screen: thresholds live in the session-setup prompts prose and the orchestrator capacity-gate script, not in settings; moving them into settings is 8294's job.

## Fork D: heavy admission and host

Fork-existence: `minMemoryHeadroomMb` 512 is a floor for a small laptop and `heavyAdmission.cap` 4 serialised heavy tests for 12 cores.
- D1: leave. 4 heavy slots on 30 cores leaves about 80% idle.
- D2 (default): `cap` 4 -> 8, `fastSlots` 2 -> 4, `minMemoryHeadroomMb` 512 -> 8192, `maxLoadPerCore` stays 9 (already scales: 270 absolute vs 108), `remote.loadPerCoreThreshold` stays 1 (30 on the Studio: heavy runs stay local until it is busy).
- D3: raise cap to 12. Test suites are multi-core, so 12 can oversubscribe; revisit after a day of data.
Skeptic: if the Studio runs heavy jobs plus daemons, 8 x multi-core tests could spike load; the R915 revert rule and `maxLoadPerCore` catch it. Survives.
Screen: n/a for layering; one platform file.

## Fork E: lane pool size

Fork-existence: the pool already grows on demand (4 at a time, hard max 90), so a fixed number is not a decision.
Dissolved: no change. It is a "Supported by default" entry, not a fork. Revisit if `acquire` growth events spike.

## Rollout and proof

1. Apply A2, B2, C2, D2 together in the platform preferences by the orchestrator (not this card's PR).
2. Re-sample host-sampler for 24 h; compare idle, free memory, swap and merge rate before and after. Revert any group where idle < 25% or mem free < 30% for 30 min.
3. Hand the final numbers to 8324 as AIMD starting bounds.

## Acceptance

- [A1] **Executable** — `node we:scripts/backlog.mjs show x5n902w` shows this decision prepared, and the platform preferences carry the ratified values after ratification.

## Non-goals

- [N1] No setting is changed by this card; the Studio values apply only after the decision is ratified.

## Edge cases this change must handle

1. **Untrusted text** — n/a: numbers only.
2. **Truncated reads** — the sample is 46 points (22 min); raises are staged and the 24 h re-sample decides.
3. **Shared state files** — the platform preferences file is edited by the orchestrator only.
4. **Fail closed** — the R915 revert rule restores the old value when idle or memory fall below the floor.
5. **Identity scoping** — n/a: host-wide limits.
6. **State over time** — MacBook may return as a second machine (R127); per-host values would need 8294's cascade.
7. **Who wrote it** — prepared by an agent from rulings and sampler data; unratified.
