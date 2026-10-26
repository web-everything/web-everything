# Heavy admission: adaptive capacity and controller authority

**Date**: 2026-10-25 (ET)
**Point**: Source-grounded preparation of #3610; proposed defaults only, no ratification or controller implementation.
**Research page**: `/research/heavy-admission-adaptive-cap/`
**Decision**: `we:backlog/3610-how-far-to-take-heavy-command-admission-control-beyond-stage.md`

## Question

Should heavy-command admission remain fixed, gain an EWMA cap, or learn its own weights and limits? The original card assumed no resource sampling and recommended EWMA partly on implementation cost. Both premises need correction before a merit decision.

## Recommendation

Separate strategy from authority. Fixed, EWMA, and learned estimators can share an admission kernel; support all without ratifying an algorithm monopoly. Recommend an independently configured capacity envelope that an estimator cannot raise. Continue the current effective target and resource gate while shadow evidence evaluates proposals. This is not a claim that fixed capacity wins on throughput, nor a scheduling decision about which implementation to build first.

The surviving fork compares (a) the independent envelope, (b) an EWMA-owned ceiling, and (c) a learner-owned ceiling/weights/parallelism. Composing an independent clamp with (b)/(c) produces (a). Their autonomous authority is rejected; their algorithms are supported.

## Survey and observed evidence

| Source | Observation | What it does not prove |
| --- | --- | --- |
| we:backlog/3608-stage-1-sample-real-cpu-memory-usage-per-heavy-command-run-a.md:6 | Stage 1 remains open; it specifies acquire/release correlation. | An open card alone does not prove no implementation exists. |
| we:scripts/lib/resource-sampler.mjs:91 and :136 | Current sampler includes slot occupancy with CPU, memory, disk, sessions, and lane count. | Aggregate host deltas are not per-process or per-command demand. |
| we:scripts/conveyor/resource-sampler-job.mjs:13 | Sampling loop defaults to 10 seconds and checks ownership before writes. | It can miss a short command between samples. |
| we:scripts/lib/resource-admission.mjs:24 | Snapshot/history/shadow share a resolved coordination root; history is bounded, snapshot is atomic. | Best-effort history is not a complete trial ledger. |
| we:scripts/lib/resource-policy.mjs:8 | Recorded calibration used 1,261 snapshots, 2026-10-09 19:27–23:01 ET: idle p5/p25/p50/p95 = 11/19/24/49%; load 11–109; memory pressure 2 throughout. | No fixed-vs-EWMA randomized or matched trial is recorded here. |
| Same source, :12 | Disk busy read 100% even with CPU idle; default disk gating remains disabled. | Disk busy is not automatically a contention outcome. |
| we:backlog/4343-load-cap-admits-on-instantaneous-load-average-which-our-own.md:25 | September historical audit: 3,239 samples; idle median 43.5%; load-gate hold 7.5% versus idle-median hold 0.7%. | This is a prior author's recorded audit, not a new live measurement or proof of cap tuning. |
| we:backlog/3975-host-sampler-admission-wait-s-is-almost-never-recorded-so-th.md:12 | Historical wait attribution only 2/927 heavy episodes; card remains open. | Absent wait is not zero wait; snapshot presence does not establish an event-level repair. |
| we:scripts/readiness/heavy-admission.mjs:730 | Shared resource verdict decides in enforce mode; legacy load gate is a comparison/fallback. | The old report's no-sampler claim is no longer current. |
| we:scripts/readiness/heavy-admission.mjs:399 | Fast slots already scale subject to demand, freshness, CPU/memory and a maximum. | Fast scaling does not establish an EWMA heavy cap or learned controller. |
| we:scripts/readiness/heavy-admission.mjs:1693 | A deferred run returns exit 75 without executing; unslotted timeout is an explicit policy. | The original card's unconditional fail-open rationale is unsafe to reuse. |

The historical host-sampler modules named by older cards are not present under their old paths in this checkout. The current resource sampler and legacy telemetry reader were surveyed directly. No raw host telemetry was copied into the report, and no new live-host experiment was performed. Searches of current admission/resource modules did not establish a joined per-command corpus or a learned/EWMA heavy-target implementation. These are bounded findings about the surveyed source, not assertions about every external prototype.

## Known occurrences and short external comparison

| Occurrence | Relevant mechanism | Transfer limit |
| --- | --- | --- |
| WE resource policy and fast-slot scaling | Independent policy thresholds, fresh snapshot, bounded expansion | Already stronger than the original cap-only premise; retain these controls. |
| GNU Parallel and Bazel, recorded by the September survey | Load-sensitive starts and declared local resource budgets | Historical comparison from we:reports/2026-09-02-heavy-command-admission-queue.md:44; neither supplies a calibrated policy for this workstation. |
| Linux PSI | Resource stall-time accounting and pressure triggers | Outcome-signal analogy only; this macOS sampler does not provide PSI. |

[Linux kernel PSI documentation](https://docs.kernel.org/accounting/psi.html) was read during this session. It distinguishes partial/full stalls and windowed pressure triggers; that supports measuring lost progress rather than treating load average as saturation. The GNU Parallel design page could not be re-fetched (timeout), and the Bazel reference exceeded the fetcher's content limit. Their descriptions above are explicitly attributed to the earlier in-repo survey; no new version-specific claims rely on those failed fetches. TCP/AIMD and Kubernetes add no necessary distinction to the authority fork and are not used as extra votes for the default.

## Classification and architecture

This is operational tooling, outside browser standards. Sampling, resource verdict, slot ownership, command weights, and worker parallelism are separate controls. The policy strategy is injectable/configurable; the independent capacity constraint is the forced invariant. The proposed design never promotes a strategy by expanding its own safety limit. Nonfinite/oversized proposals and missing required evidence cannot expand capacity; hold/defer remains operator-visible with a repair or explicit settings fallback.

The [admission statute](../docs/agent/platform-decisions.md#heavy-command-admission-queue) supports conservative capacity bounds and reserved workstation headroom but does not itself settle adaptive ownership. The [fixed-settings decider rule](../docs/agent/platform-decisions.md#delivery-decider-under-fixed-settings) makes fixed values final and limits automatic fields to sibling bounds, initially in shadow. The later [operator override settings layer](../docs/agent/platform-decisions.md#operator-override-settings-layer) extends the earlier committed-settings source with standard < platform < tool < env < operator-override resolution, effective-source logging, operator authorization for writes and confirmation for loosening. They compose by resolving settings first and allowing automatic proposals only within the independent operator envelope and invariants. The delivery decider remains deterministic in v1 and only orders heavy-work priority; it does not own the cap. Applying this authority boundary to heavy-target estimation, including learned strategies, is a proposed extension requiring ratification. Fixed, EWMA and learned strategies can coexist beneath the envelope. #6678 is related open weighted-accounting work, not a prerequisite ruling silently assumed true.

## Evaluation needed for implementation

A shadow corpus needs command kind, policy version, start/end and admission wait, occupancy, resource signals, outcomes and exclusion reasons. Compare matched command classes and occupancy; report throughput, wait tails, timeouts and pressure together. Historical low occupancy or high idle alone does not prove that a cap change improves completed work. Preserve known fast-lane and priority behavior, do not kill holders after shrinking a target, and serialize admissions so multiple clients cannot reserve the same headroom.

Named follow-on tests are in the card: simultaneous expansion, oversized/nonfinite output, stale/partial evidence, natural drain, and exit-75 fallback. No runtime claim is made by this authoring pass.

## Files created or modified

| File | Action |
| --- | --- |
| we:backlog/3610-how-far-to-take-heavy-command-admission-control-beyond-stage.md | Rewrite body; preserve frontmatter. |
| we:src/_data/researchTopics/heavy-admission-adaptive-cap.json | Add topic and relatedReport. |
| we:src/_includes/research-descriptions/heavy-admission-adaptive-cap.njk | Publish findings. |
| we:reports/2026-10-25-heavy-admission-adaptive-cap.md | This session artifact. |

## Verification boundary

Pure authoring. No status, preparedDate, settings, or implementation changes; no human judgment recorded. Fresh-context skeptic review retained the independent envelope with the settings/statute reconciliation above; the two-confusion screen is clear. Any orchestrator stamp remains separate. Check results are reported in the delivery response; they are not evidence of controller performance.
