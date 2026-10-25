---
bornAs: xqraqab
kind: decision
parent: "3611"
status: open
dateOpened: "2026-09-07"
preparedDate: "2026-10-25"
preparedAgainstSha: "b19c459fd7ceb2705cde89206bcc02920ab83539"
tags: []
---

# Heavy admission beyond Stage 1: fixed ceiling, adaptive target, and learned proposals

## Digest

The original fixed-cap/EWMA/learned-policy choice mixes a configurable strategy with a safety rule. The [research survey](/research/heavy-admission-adaptive-cap/) grounds one forced-invariant fork: **keep the operator's capacity envelope independent of the controller**. Fixed, EWMA, and learned strategies can coexist inside it. Current code already samples resources and gates admission; Stage 1's complete per-command feedback is not established. Recommend retaining the current effective cap while evaluating adaptive proposals against complete evidence, without ratifying a schedule or changing settings here.

The axes are **measurement** (we:scripts/lib/resource-sampler.mjs:136), **admission verdict** (we:scripts/lib/resource-policy.mjs:58), and **capacity authority** (we:scripts/readiness/heavy-admission.mjs:220). Host pressure, a job's measured demand, and permission to create a slot are different facts. The session artifact is `we:reports/2026-10-25-heavy-admission-adaptive-cap.md` (the topic's `relatedReport`).

| Fork | Recommended default | Main alternative | Confidence |
| --- | --- | --- | --- |
| 1 — controller authority | (a) independently configured ceiling and resource gate | (b) EWMA or (c) learned policy owns the ceiling | High on authority boundary; no measured winner among strategies |

## Fork 1 — Can feedback redefine its own capacity limit?

**Fork-existence:** a controller that may raise the very limit constraining it defeats the operator's capacity guarantee; composing its proposal with an independent clamp works, but that composition is option (a), not autonomous ownership of the ceiling.

The crux is authority, not whether EWMA is cheaper than learning. The [standing admission rule](../../docs/agent/platform-decisions.md#heavy-command-admission-queue) reserves workstation headroom and separates heavy capacity from lane leasing: it supports conservative bounds but does not itself settle adaptive ownership. Current fast-slot scaling already uses an independent maximum and fresh-resource conditions (we:scripts/readiness/heavy-admission.mjs:399).

The [fixed-settings decider rule](../../docs/agent/platform-decisions.md#delivery-decider-under-fixed-settings) makes fixed values final, allows a decider only for fields set to `auto` within sibling bounds, and starts those fields in shadow. The [operator override settings layer](../../docs/agent/platform-decisions.md#operator-override-settings-layer) first resolves standard < platform < tool < env < operator-override, logs the effective source, and requires operator authorization plus confirmation for loosening writes; it extends the earlier decider rule's committed-settings-only source with this authorized top layer. They compose in that order: resolve the operator's settings, then let a controller propose only for an explicitly automatic target inside the independent envelope; neither the controller nor the override layer relaxes invariants. The delivery decider's v1 remains deterministic, not learned, and its heavy-work role is priority ordering, not cap ownership. Extending this authority boundary to heavy-target controllers, including learned estimators, is proposed here, not already authorized by either rule.

- **(a) Hold an independently configured capacity envelope; allow fixed, EWMA, or learned targets beneath it. Recommended default.** The fixed strategy returns the configured target. Adaptive strategies may lower or propose raising the effective target within separately authorized heavy/fast budgets; they cannot reclassify work to escape accounting, alter worker parallelism, or reserve lane slack implicitly. The resource gate still decides whether a free slot may be used. Tradeoff: idle capacity above the envelope remains unused until an explicit settings change. That preserves a predictable bound even when estimates are wrong.
- (b) EWMA owns the heavy ceiling. A smoothed CPU/memory headroom signal can react to changing contention without per-command training. **Rejected as an authority model:** a trailing aggregate is not a reservation for work about to start; simultaneous admissions can all observe the same idle interval, and smoothing can conceal a short pressure spike. An independently bounded EWMA target is supported under (a), so EWMA itself is not rejected.
- (c) Learned policy owns the ceiling, command weights, parallelism, and slack reservations. It can model heterogeneous commands and interactions. **Rejected as an authority model:** the evaluator and resource budget become outputs of the same fallible policy; biased or incomplete outcomes can reward unsafe expansion. Even a perfectly implemented learner needs an independent constraint. Learned proposals within (a), including separately authorized weighted-budget experiments, remain supported.

**Classification (seven-question pass):** (1) operational tooling, not a WE plug/block/intent; (2) no browser conformance or UX dimension; (3) expose the full fixed/EWMA/learned strategy axis; (4) the independent envelope is a fixed invariant, strategy is configurable; (5) inject estimator/clock/snapshot IO into the tool, not browser DI; (6) permit any strategy that obeys the envelope, with no new strategy enabled by this authoring; (7) sampling, admission, reservations, and execution remain separate seams. Free implementation and maintenance would not remove the authority defect in (b)/(c).

**Fork 1 (a), existing code shape** — the shipped fast-slot helper already composes demand, resource evidence, and a separately configured maximum. From the repository root (imports are code, not new APIs):

```js
import { ADMISSION_POLICY_STANDARD, resolveEffectiveFastSlots }
  from './scripts/readiness/heavy-admission.mjs';
const settings = ADMISSION_POLICY_STANDARD;
const fastSlots = resolveEffectiveFastSlots({
  policy: settings, waiting: [], snapshot: null, nowMs: 0,
}); // retains settings.fastSlots; absent evidence cannot expand it
```

For the heavy pool, the proposed analogue is a target clamped to the operator's heavy ceiling, with the existing resource verdict checked before atomic slot acquisition. A lower target drains naturally; it never kills a running holder or renumbers its slot. EWMA alpha/window, hysteresis, and learned weights are configuration, not additional forks. The helper above is shipped; a general heavy-target controller is not.

Skeptic: SURVIVES-WITH-AMENDMENT -- The independent operator envelope stays; fixed, EWMA, and learned strategies are compatible configuration beneath it, subject to resolved settings and invariants rather than authority inferred from the admission-queue rule.

Screen: clear

## Supported by default (not decisions)

- **All three strategies, one authority boundary.** Composition succeeds: fixed and EWMA estimators and a learned estimator can feed the same bounded admission kernel. The initial operational recommendation is the existing fixed effective cap plus current resource gates. Selecting an experimental strategy is a settings/validation action, not a claim that only one algorithm may ever exist.
- **Measurement before an adaptive promotion.** Reuse resource snapshot/history and shadow comparisons. Require complete joinable records for command kind, wait, occupancy, CPU/memory, duration, outcome, policy version, and baseline. Compare matched command classes and occupancy bands; report omitted/unknown records and throughput, wait tails, timeout rates, and pressure together. No numeric alpha, reward, or improvement margin is claimed calibrated by the aggregate data below.
- **Bounded rollout.** Start proposed controllers in shadow; promotion requires a replay corpus with no envelope violations and an operator-approved outcome comparison. Missing/stale/partial required inputs cannot expand capacity or count as success. Emit the reason and retain the configured target subject to the resource gate; if that gate holds, defer with exit 75 and surface sampler repair/settings review as the operator fallback. This is a proposed controller guarantee, not a claim that every legacy error path already fails closed.
- **Separate controls.** Command weighting and internal parallelism can compose with admission but require explicit resource accounting. The existing slot protocol, reentrancy, priority, and fast lane remain inputs to that work. No EWMA or learner may silently turn on the explicit unslotted-run escape hatch.

## Context

### What Stage 1 evidence actually exists

| Observation | Evidence and limit |
| --- | --- |
| Stage 1 card remains open | we:backlog/3608-stage-1-sample-real-cpu-memory-usage-per-heavy-command-run-a.md:6 asks for acquire/release samples; its claim that no sampling exists is historical, not current truth. Parent #3611 is still open. |
| Current sampler correlates host resources and occupancy | we:scripts/lib/resource-sampler.mjs:91 reads heavy occupancy; :136 includes it in CPU/memory/disk snapshots. we:scripts/conveyor/resource-sampler-job.mjs:13 defaults to a 10-second cadence. This is host correlation, not causal per-command CPU attribution. |
| Aggregate measurements are recorded in source | we:scripts/lib/resource-policy.mjs:8 documents 1,261 snapshots on 2026-10-09, 19:27–23:01 ET: idle p5/p25/p50/p95 11/19/24/49%; load 11–109; pressure level 2 throughout; disk busy 100% even with idle CPU. Those data calibrated thresholds, not an EWMA cap or learned reward. |
| Earlier data disproved load-average-only admission | we:backlog/4343-load-cap-admits-on-instantaneous-load-average-which-our-own.md:25 records 3,239 samples, idle median 43.5%, and normal memory pressure; its historical hold comparison is 7.5% for load versus 0.7% for idle median. Different dates and signal semantics must not be pooled blindly. |
| Wait feedback is incomplete in the historical episode stream | we:backlog/3975-host-sampler-admission-wait-s-is-almost-never-recorded-so-th.md:12 reports wait on only 2 of 927 episodes. That card is open; the current snapshot shape does not establish repair of event-level wait attribution. |
| Policy has moved beyond the original cap-only premise | we:scripts/readiness/heavy-admission.mjs:730 uses the shared resource gate in enforce mode. The built-in heavy cap is 2 (:166), not proof of the host's effective configuration. Fast capacity is separate (:220). |
| Timeout is no longer an unconditional fail-open recommendation | we:scripts/readiness/heavy-admission.mjs:1693 returns exit 75 for deferral; explicit policy may still permit unslotted timeout execution. we:scripts/lib/resource-gate.mjs:186 retains the legacy verdict if the shared observer fails. Do not equate this with missing-snapshot handling in we:scripts/lib/resource-policy.mjs:77. |

This is a checkout/source survey with historical measurements, not a fresh live-host experiment. No matched trace comparing fixed, EWMA, and learned caps was found in the surveyed admission/resource modules; no claim of Stage 1 completion or adaptive speedup follows.

### Known occurrences

- **WE resource gate and fast lane:** independently configured thresholds plus bounded scaling are already shipped in the code cited above.
- **GNU Parallel load gating and Bazel resource pools:** the earlier [queue survey](/research/heavy-command-admission-queue-capacity-throttle/) records these shipped approaches. They support separating observation from declared capacity; neither establishes a winner for this host. Its September recommendation is historical evidence, not today's implementation inventory.
- **Linux PSI:** [kernel documentation](https://docs.kernel.org/accounting/psi.html) exposes CPU/memory/IO stall time and threshold triggers. It illustrates a contention outcome signal; it is not a macOS API or a reason to infer stall time from idle percentage.

### Related work and proposed build boundary

#3608 owns missing sampling, #3611 the staged project, and #6678 proposes weighted resource reservations while retaining hard concurrency caps. The latter is open work, not authority for this default. Reuse the landed #5715 resource cutover; do not resurrect a parallel load-average controller. The browser CapacityProvider work (#729/#767) concerns consumer devices and does not own host scheduling.

Predicted follow-on touch-set: `we:scripts/readiness/heavy-admission.mjs`, `we:scripts/lib/resource-policy.mjs`, `we:scripts/lib/resource-admission.mjs`, `we:scripts/lib/resource-sampler.mjs`, and their scoped tests. Any reusable rule approved later belongs beside the admission anchor; this preparation changes no statute or runtime.

## Done when

1. **Authoring executable:** use we:scripts/readiness/heavy-admission.mjs to check this card, research topic, and report. It checks repository structure, not the policy's performance.

   ```sh
   node scripts/readiness/heavy-admission.mjs run --wait-ms=60000 -- npm run check:standards
   ```

2. **Ratification result:** record the operator's selection and codify the independent-envelope rule only after ratification; scope the chosen implementation under #3611 without declaring Stage 1 complete.
3. **Build executable and guarantees:** the follow-on tests we:scripts/readiness/__tests__/heavy-admission.test.mjs and we:scripts/lib/__tests__/resource-admission.test.mjs:

   ```sh
   node scripts/readiness/heavy-admission.mjs run --wait-ms=60000 -- npm run test:unit -- scripts/readiness/__tests__/heavy-admission.test.mjs scripts/lib/__tests__/resource-admission.test.mjs
   ```

   Add named cases for concurrent proposals at the ceiling, oversized/nonfinite proposals, stale and partial input, draining after a target decrease, and deferred fallback. Also add these planned cases:

   - `we:scripts/readiness/__tests__/heavy-admission.test.mjs::EWMA and learner cannot enable unslotted execution`
   - `we:scripts/readiness/__tests__/heavy-admission.test.mjs::adaptive strategies cannot reclassify work`
   - `we:scripts/readiness/__tests__/heavy-admission.test.mjs::adaptive strategies cannot alter worker parallelism`
   - `we:scripts/readiness/__tests__/heavy-admission.test.mjs::adaptive strategies cannot reserve lane slack`
   - `we:scripts/readiness/__tests__/heavy-admission.test.mjs::resolveEffectiveFastSlots with snapshot null retains settings.fastSlots`

   Preserve the explicit operator escape-hatch tests. A matched shadow report must accompany any later controller promotion.

### Review jury (provisional — pre-registered #2638)

Care level: `high`. This jury binds against the item's predicted scope and is re-checked against the real diff at PR open.

| juror | lens | grounding method | pre-registered expectation |
| --- | --- | --- | --- |
| correctness#1 | correctness | static-review | The change does what the spec says with no behaviour regression — every changed branch is exercised, and no test is missing, weakened, or gamed to pass while the behaviour is wrong. Current release level: internal delivery (single operator, no outside users). Hardening against outside attackers (forged identity, ingress size or rate limits, provenance, tamper detection, races between operators) is DEBT, filed as a card, and NOT a blocking finding. Exceptions that still block: a secret actually exposed, a guard weakened or fail-open, irreversible data loss, delivery instability. Per the review-stringency decision (we:platform-decisions.md#review-stringency-classified-outcomes); superseded when slice 2's settings table lands. |
| correctness#2 | correctness | static-review | The change does what the spec says with no behaviour regression — every changed branch is exercised, and no test is missing, weakened, or gamed to pass while the behaviour is wrong. Current release level: internal delivery (single operator, no outside users). Hardening against outside attackers (forged identity, ingress size or rate limits, provenance, tamper detection, races between operators) is DEBT, filed as a card, and NOT a blocking finding. Exceptions that still block: a secret actually exposed, a guard weakened or fail-open, irreversible data loss, delivery instability. Per the review-stringency decision (we:platform-decisions.md#review-stringency-classified-outcomes); superseded when slice 2's settings table lands. |
| security#1 | security | static-review | No untrusted input, secret, auth, or file/network path is left unguarded and the trust boundary is not widened — anything touching those earns an explicit security check. Current release level: internal delivery (single operator, no outside users). Hardening against outside attackers (forged identity, ingress size or rate limits, provenance, tamper detection, races between operators) is DEBT, filed as a card, and NOT a blocking finding. Exceptions that still block: a secret actually exposed, a guard weakened or fail-open, irreversible data loss, delivery instability. Per the review-stringency decision (we:platform-decisions.md#review-stringency-classified-outcomes); superseded when slice 2's settings table lands. |
| security#2 | security | static-review | No untrusted input, secret, auth, or file/network path is left unguarded and the trust boundary is not widened — anything touching those earns an explicit security check. Current release level: internal delivery (single operator, no outside users). Hardening against outside attackers (forged identity, ingress size or rate limits, provenance, tamper detection, races between operators) is DEBT, filed as a card, and NOT a blocking finding. Exceptions that still block: a secret actually exposed, a guard weakened or fail-open, irreversible data loss, delivery instability. Per the review-stringency decision (we:platform-decisions.md#review-stringency-classified-outcomes); superseded when slice 2's settings table lands. |
| simplicity#1 | simplicity | static-review | The change is the smallest one that solves the problem — it reuses what already exists and adds no dead code or needless abstraction. |
| simplicity#2 | simplicity | static-review | The change is the smallest one that solves the problem — it reuses what already exists and adds no dead code or needless abstraction. |
| standards-conformance#1 | standards-conformance | static-review | The change follows this repo's conventions and platform-native defaults, and does not diverge from a ratified standard or placement rule. |
| standards-conformance#2 | standards-conformance | static-review | The change follows this repo's conventions and platform-native defaults, and does not diverge from a ratified standard or placement rule. |
| claim-accuracy#1 | claim-accuracy | static-review | Every factual claim the change makes about the repo holds against the repo: a cited path:line names what is actually there, a quoted grep literal really matches, a stated count is the real count, a referenced id or link resolves, and anything the description says was changed appears in the diff. |
| claim-accuracy#2 | claim-accuracy | static-review | Every factual claim the change makes about the repo holds against the repo: a cited path:line names what is actually there, a quoted grep literal really matches, a stated count is the real count, a referenced id or link resolves, and anything the description says was changed appears in the diff. |
