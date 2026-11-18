---
bornAs: x5n902w
kind: decision
size: 3
status: open
scope: ["we:scripts/settings/delivery-capacity.json"]
scopeRationale: "Decision-only card: cross-owner targets and repository-qualified test paths below describe future rollout implementation, not additional files changed by this PR."
dateOpened: "2026-11-16"
preparedDate: "2026-11-16"
preparedAgainstSha: "51631f0e3fc7a8d49e3b8407a51bfbdaf0f9f472"
tags: []
---

# Re-tune every previous-host load and capacity limit for the primary host

Operator 2026-11-16 19:45 ET: the open-PR cap is a soft limit already planned to go dynamic, and every load limit needs review now the daemons run on the primary host. Covers we:scripts/settings/review-concurrency.json, we:scripts/settings/delivery-capacity.json, we:scripts/lib/delivery-capacity.mjs and the host platform preferences.

## Measured: previous host baseline vs primary host

| Signal | previous host (rulings) | primary host (host-sampler, 2026-11-17T00:25Z+, 46 samples at 30 s, about 22 min) |
|---|---|---|
| Hardware | Previous host capacity (R732) | Increased host capacity (host-sampler) |
| Load at the R915 revert | 45 (3.75 per core), CPU idle 11%, mem free 10.9 GB | load1 p50 8.0, p95 13.8, max 16.1 (0.27 per core at p50) |
| CPU busy | 89% | p50 20.5%, p95 42.1%, max 55.8% (`top -l 2`: 92% idle) |
| Memory | free 10.9 GB, swap 4.6 GB in the 2026-10-20 emergency | available p50 74 GB, free p50 49 GB, swap 0, compressed 0, pressure level 1, thermal 100% |

Caveat: the primary host window is short and was taken during light load, right after the move. It motivates reviewing the old limits but establishes neither sustained raise eligibility nor a new ceiling. Every default below is a proposed target after ratification; apply it only through the staged rollout and fresh observation gates below. The observed capacity ratio informs targets, not permission to apply them now.

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

Existing cards, not duplicated here: [8294](/backlog/8294-delivery-capacity-settings-r927-need-a-product-home-with-the/) (product home for these keys), [8324](/backlog/8324-delivery-capacity-setting-weighted-load-units-stuck-sub-cap/) (weighted units plus AIMD auto-tune = the planned dynamic open-PR cap), [8387](/backlog/8387-capacity-gate-should-use-delivery-signals-not-just-idle-cpu/) (gate on delivery signals). This card sets the primary host values those cards will tune from. It builds no code.

### Recommended path at a glance

| Fork | Group | Default |
|---|---|---|
| A | Open-PR cap | static soft cap 18 -> 30 in stage 4; 8324 AIMD then drives it |
| B | Review / red-team / fix concurrency | `maxLiveReviewRounds` 3 -> 8, red-team queue 5 -> 8, fix cap re-raised under the R915 rule |
| C | Gate and worker thresholds | scale load numbers by 2.5; `memMinGb` 4 -> 12; worker ceiling 10 -> 16 |
| D | Heavy admission and host | heavy cap 4 -> 8, fastSlots 2 -> 4, `minMemoryHeadroomMb` 512 -> 8192, keep `maxLoadPerCore` 9 |
| E | Lane pool | no change (15 lanes, grows on demand to 90) |

## Supported by default (not forks)

- `idleMinPct` 15 stays: a percentage already scales with core count. It is the primary gate (R702); load average stays secondary.
- `remote.maxConcurrent` 16 stays: it limits Forge jobs, not the primary host.
- merge-queue `gateReads` 6 / `enqueue` 3 stay: bounded by GitHub API rate, not host load.
- Every raise keeps the R915 revert rule (revert when idle < 25% or mem free < 30% for 30 min) and is applied by the orchestrator in steps, not at once.

## Fork A: open-PR cap (18, soft, +2 over-cap starts)

Fork-existence: a single number must be chosen; 18 is the previous host value (R915 applied it because merges stalled and red-team capacity was 5), so keeping it on a 2.5x host would idle the machine.
- A1: keep 18 until AIMD (8324) ships. Safe, wastes the primary host.
- A2 (default): static cap 30, `softOverCapStarts` 4, `maxStartsPerCheck` 8 -> 12 in stage 4; 8324's shadow auto-tune (units 12-48) takes over and the R915 raise rule (merge rate >= 2/h, red-team free slots, fix pass < 30 min) becomes the dynamic brake.
- A3: cap 45 at once. Blocked by review and red-team concurrency (Fork B), so extra PRs just queue.
Why A2: the PR cap is bound by Fork B's seats, not CPU. 30 is ~1.7x, matching a review seat increase of 2.7x with margin for conflicts.
Skeptic: A2 wrong if merge conflicts scale faster than the cap; mitigated by the soft mode and the R915 drop-back rule. Survives.
Screen: single-axis numeric choice, no layering or naming confusion.

## Fork B: review, red-team and fix concurrency

Fork-existence: `maxLiveReviewRounds` 3 is an emergency from 114 MB free; the file's own revert condition says to raise it once host admission is memory-aware. The primary host has 74 GB available, so leaving 3 is the broken branch.
- B1: 3 -> 5. Cautious.
- B2 (default): 3 -> 8, red-team queue 5 -> 8, fix cap back to the pre-revert value only after fresh observations establish idle > 25% AND mem free > 30% throughout at least 30 continuous minutes. The supplied 22-minute window and its medians do not establish eligibility; the fix cap remains reverted. Before ratification, record the exact pre-revert fix-cap value from R915 in the ratified values manifest; an absent or unverified value blocks B2 rather than guessing a number.
- B3: remove the cap. Loses the guard against a repeat of the 12 GB review-process pile-up.
Why B2: 23 review processes were about 12 GB (about 0.5 GB each), so 8 rounds is about 4-8 GB of host memory. CPU is not the limit.
Skeptic: B2 wrong if model API quotas, not the host, bind. Then more seats only queue at the provider; the cap is easy to lower. Survives.
Screen: no confusion; one setting file.

## Fork C: gate and worker thresholds

Fork-existence: the load numbers (36, 48, 60, 24) were calibrated against the host core count; load is not comparable across core counts, so reusing them is wrong, and dropping load entirely loses the secondary signal.
- C1: leave all as is. primary host at load 8 is far under every number, so it never binds; harmless but it also never protects.
- C2 (default): scale by 2.5: L<24 -> L<60, L<36 -> L<90, tests L<48 -> L<120, load-explain L>=36 -> L>=90, reducer slot load <= 60 -> <= 150; `memMinGb` 4 -> 12 (same 4% of RAM is 4 GB; 12 is about 12%); worker ceiling 10 -> 16 (same 0.8 per core x 2.5 would be 25; 16 until measured).
- C3: drop load, use idle and memory only. Cleaner, but loses the load-explain trigger; 8387 may do this later.
Skeptic: scaling by cores is crude (primary host cores may be faster, so it errs safe). Survives.
Screen: thresholds live in the session-setup prompts prose and the orchestrator capacity-gate script, not in settings; moving them into settings is 8294's job.

## Fork D: heavy admission and host

Fork-existence: `minMemoryHeadroomMb` 512 is a floor for a small laptop and `heavyAdmission.cap` 4 serialised heavy tests for the previous host.
- D1: leave. 4 heavy slots on the host leave about 80% idle.
- D2 (default): `cap` 4 -> 8, `fastSlots` 2 -> 4, `minMemoryHeadroomMb` 512 -> 8192, `maxLoadPerCore` stays 9 (already scales: 270 absolute vs 108), `remote.loadPerCoreThreshold` stays 1 (scales with host cores: heavy runs stay local until it is busy).
- D3: raise cap to 12. Test suites are multi-core, so 12 can oversubscribe; revisit after a day of data.
Skeptic: if the primary host runs heavy jobs plus daemons, 8 x multi-core tests could spike load; the R915 revert rule and `maxLoadPerCore` catch it. Survives.
Screen: n/a for layering; one platform file.

## Fork E: lane pool size

Fork-existence: the pool already grows on demand (4 at a time, hard max 90), so a fixed number is not a decision.
Dissolved: no change. It is a "Supported by default" entry, not a fork. Revisit if `acquire` growth events spike.

## Rollout and proof

This is a plan for the later orchestrator implementation, not an executable gate added by this PR. Ratification must record an exact values manifest for A2–D2 (including the sourced fix cap); application must wait for the planned gates and tests below. Platform preferences, repository settings and prompt/script thresholds each retain their existing owner and storage location.

**Eligibility gate:** use timestamped host-sampler observations at the existing 30 s cadence. Require a window spanning at least 1800 s, ending within 30 s of the check, with strictly increasing valid timestamps, no future samples, no gap greater than 30 s and finite idle and free-memory percentages within 0–100 at every point. Every point must have idle > 25% AND mem free > 30%; equality, a dip in either metric, missing fields, stale data or truncated input cannot authorize a raise. A dip restarts the window; invalid/missing/stale data holds the stage and requests fresh observations. Medians, available memory and isolated `top` readings cannot substitute for free-memory percentages and the complete window. This sampled rule cannot establish behavior between samples.

**Stage gate:** the orchestrator validates exactly one next group against this ordered plan. Reject batched groups, skipped/reordered stages, and progress without a successful post-application observation window for the preceding group. Capture the group's exact effective values before writing; an unreadable snapshot or an intervening settings change holds application for operator reconciliation. A partial application failure restores the group's snapshot and stops the rollout, using the restoration-failure handling below if needed. Never use the pre-raise window as the post-raise proof.

| Stage | Only group applied | Required proof before advancing |
|---|---|---|
| 0 | No writes: ratify manifest, capture baseline and pass eligibility | Complete fresh 30-minute window above |
| 1 | C2: memory gate and worker/load thresholds | Fresh qualifying window spanning at least 30 min entirely after C2 application |
| 2 | D2: heavy admission and host headroom | Fresh qualifying window spanning at least 30 min entirely after D2 application |
| 3 | B2: review, red-team and verified fix cap | Fresh qualifying window spanning at least 30 min entirely after B2 application |
| 4 | A2: open-PR capacity, after review capacity is observed | Fresh qualifying window spanning at least 30 min entirely after A2 application |

On idle < 25% OR mem free < 30% at every sample for 30 continuous minutes, restore all keys of the most recently applied group to its captured pre-stage values and stop advancement. The low metric may alternate; the disjunction must hold at every point. A healthy sample resets this low-resource timer. Apply the same completeness/cadence rules to restoration evidence; missing evidence holds further raises and alerts the operator to inspect the host and restore the snapshot manually if needed. If restoration fails, report the failed keys and keep the rollout stopped. Retrying a reverted stage requires a fresh qualifying 30-minute window after restoration; earlier evidence cannot be reused.

After stage 4, re-sample for 24 h and compare idle, free memory, swap and merge rate against baseline while keeping the same revert monitor active. Hand the final observed numbers to 8324 as AIMD starting bounds only after this observation completes; a revert stops that handoff.

### Planned tests and prevention gates (required before applying settings)

All paths below are repository-qualified planned files; these tests and gates are not implemented by this decision-only card. Each case must exercise the orchestrator's real application/readback or preparation path using injected observations, preferences and clock, without changing live host settings. Commands use repository-qualified path notation (`we:` resolves to this repository root). The current `we:scripts/backlog.mjs` CLI has no `show` verb (local probe exits 1 with usage); the prepared-output command in [A1] is a planned requirement that must be implemented with its named test before claiming that guarantee passes.

| Guarantee / constraint | Planned test file | Named case and observable assertion |
|---|---|---|
| Ordered rollout and observations between groups | `we:scripts/__tests__/studio-capacity-rollout.test.mjs` | `studio_rollout_observes_between_groups`: accepts C2 → D2 → B2 → A2, one group per write; rejects a multi-group request, skip/reorder and pre-application evidence, with zero writes to the next group until a fresh qualifying post-stage window completes. |
| Continuous raise eligibility, including B2 | `we:scripts/__tests__/studio-capacity-rollout.test.mjs` | `raise_requires_thirty_minutes_above_both_floors`: 22 min and 1799 s are ineligible; a complete 1800 s window with both metrics strictly above their floors is eligible; one idle or memory dip, equality, missing/nonfinite/out-of-range fields, invalid/duplicate/reordered/future timestamps, a gap > 30 s or stale end sample denies the raise despite high medians, with no preference write. |
| [A1] Prepared-state CLI output | `we:scripts/__tests__/studio-capacity-decision.test.mjs` | `studio_decision_show_reports_prepared`: invoke `node we:scripts/backlog.mjs show 8536` against the prepared card fixture; assert successful exit, this card's identity, prepared state and prepared date in output. |
| [A1] Exact ratified values across all owners | `we:scripts/__tests__/studio-capacity-rollout.test.mjs` | `studio_ratification_applies_exact_values`: after ratification and each stage's proof, read back every A2–D2 key from its owning store/script/prompt and compare with the exact ratified manifest, including the verified pre-revert fix cap; unchanged defaults stay unchanged. Missing/unverified fix-cap values deny B2 with no B2 writes. |
| [N1] No settings changed before ratification | `we:scripts/__tests__/studio-capacity-decision.test.mjs` | `studio_preparation_does_not_apply_preferences`: prepare/show an unratified card with settings writers spied; assert zero writes and byte-identical preference/settings fixtures. |
| Edge 4: restoration and retry | `we:scripts/__tests__/studio-capacity-rollout.test.mjs` | `studio_restores_snapshot_after_sustained_low_resources`: separately inject 30 min of low idle, low free memory and alternating low metrics; assert exact pre-stage values restored for every key in the last group, earlier groups preserved and no next-stage write or handoff. At 1799 s do not restore; a healthy sample resets the timer. After restoration deny retry until a new qualifying window completes. |
| Incomplete evidence and failed recovery | `we:scripts/__tests__/studio-capacity-rollout.test.mjs` | `studio_rollout_holds_on_incomplete_evidence_or_restore_failure`: missing/stale samples, unreadable snapshots or changed settings prevent further writes and report operator action; a partial application failure restores the captured group snapshot and stops; failed restoration reports failed keys and never advances. |
| Final observation before AIMD handoff | `we:scripts/__tests__/studio-capacity-rollout.test.mjs` | `studio_handoff_waits_for_observation`: before 24 h after stage 4 assert no handoff; at 24 h assert baseline comparison and observed values passed to 8324; a revert suppresses handoff. |
| Every guarantee has an explicit test mapping | `we:scripts/__tests__/studio-capacity-decision.test.mjs` | `studio_preparation_requires_guarantee_test_mapping`: preparation validation rejects an acceptance or behavioral constraint with a missing repository-qualified file, named case or observable assertion; deleting any mapping above blocks preparation with the unmapped guarantee identified. |

Prevention work recorded here from PR #6951 (owed, not shipped): (1) implement the ordered stage validator and `studio_rollout_observes_between_groups`; (2) implement the duration/completeness/pointwise eligibility validator and `raise_requires_thirty_minutes_above_both_floors`; (3) implement the preparation mapping gate and `studio_preparation_requires_guarantee_test_mapping`. These are prerequisites for executing this rollout, not a claim that current tooling enforces the plan.

## Acceptance

- [A1] **Executable (planned rollout acceptance)** — once implemented, `node we:scripts/backlog.mjs show 8536` shows this decision prepared (`we:scripts/__tests__/studio-capacity-decision.test.mjs`, `studio_decision_show_reports_prepared`). After ratification and successful staged rollout, every owning store carries its exact ratified values (`we:scripts/__tests__/studio-capacity-rollout.test.mjs`, `studio_ratification_applies_exact_values`); ratification alone does not authorize simultaneous application.

## Non-goals

- [N1] No setting is changed by this card; the primary host values apply only after the decision is ratified and rollout gates pass (`we:scripts/__tests__/studio-capacity-decision.test.mjs`, `studio_preparation_does_not_apply_preferences`).

## Edge cases this change must handle

1. **Untrusted text** — n/a: numbers only.
2. **Truncated reads** — 46 points (22 min) cannot authorize a raise; require the complete continuous window and staged proof (`we:scripts/__tests__/studio-capacity-rollout.test.mjs`, `raise_requires_thirty_minutes_above_both_floors`).
3. **Shared state files** — the orchestrator is the sole rollout writer, captures the pre-stage snapshot and holds on intervening settings changes (`we:scripts/__tests__/studio-capacity-rollout.test.mjs`, `studio_rollout_holds_on_incomplete_evidence_or_restore_failure`).
4. **Fail closed** — sustained low idle OR free memory for 30 min restores exact pre-stage values and stops advancement; missing evidence holds and alerts (`we:scripts/__tests__/studio-capacity-rollout.test.mjs`, `studio_restores_snapshot_after_sustained_low_resources`, `studio_rollout_holds_on_incomplete_evidence_or_restore_failure`).
5. **Identity scoping** — n/a: host-wide limits.
6. **State over time** — previous host may return as a second machine (R127); per-host values would need 8294's cascade.
7. **Who wrote it** — prepared by an agent from rulings and sampler data; unratified.
