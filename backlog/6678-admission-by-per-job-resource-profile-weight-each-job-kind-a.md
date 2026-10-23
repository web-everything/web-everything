---
bornAs: xwfgsk7
size: 13
kind: story
status: open
scope: ["we:scripts/lib/resource-policy.mjs", "we:scripts/lib/resource-admission.mjs", "we:scripts/lib/resource-sampler.mjs", "we:scripts/lib/resource-gate.mjs", "we:scripts/readiness/heavy-admission.mjs", "we:scripts/operations/review-seat-runner.mjs", "we:scripts/review-set-label.mjs", "we:scripts/lib/review-seat-settings.mjs", "we:scripts/lib/__tests__/resource-admission.test.mjs", "we:scripts/lib/__tests__/resource-sampler.test.mjs", "we:scripts/readiness/__tests__/heavy-admission.test.mjs", "we:scripts/operations/__tests__/review-seat-runner.test.mjs", "we:scripts/__tests__/review-set-label.test.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# Admission by per-job resource profile: weight each job kind and admit against its limiting resource (memory, CPU, model quota, GitHub rate)

Extend the existing per-kind resource policy with weighted CPU/memory reservations and model/GitHub quota classes, rather than introduce a second admission engine. Existing kinds already have CPU-idle and memory-pressure thresholds; the remaining work is aggregate resource accounting, quota signals, caller integration and a symptom brake. Keep concurrency caps and the host-load backstop. Treat the original 2026-10-20 numbers as proposed replay inputs, not newly verified measurements.

## Done when

Commands use the Bash helper `we() { command "${@#we:}"; }` to strip repository prefixes from arguments.

- [A1] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/lib/__tests__/resource-admission.test.mjs` — add weighted-reservation tests for verify/vitest, review, red-team and label writes: each holds when its own budget is exhausted and remains eligible when an unrelated quota is exhausted. These fail before profile accounting exists; include two concurrent acquisitions competing for the final budget.
- [A2] Replay explicit fixtures with load 30/free memory 10 GB admitting a review, and load 52/free memory 0.6 GB holding verification. State CPU count, idle percentage, freshness and quota headroom in each fixture so the outcome is reproducible and the backstop is not silently bypassed.
- [A3] Integrate reservations at the heavy subprocess wrapper, review/red-team seat runner and label-write producer. Release on completion, failed spawn and timeout; recover crashed owners without double refund. A subprocess cannot escape accounting by choosing a cheaper kind.
- [A4] Test a bounded timeout-rate/pass-duration window tightening all budgets and restoring them after a documented quiet window; record thresholds, measured inputs and reasons with every decision.
- [A5] Validate finite nonnegative weights and quota units. Runtime changes take effect on the next admission with per-field source attribution; reducing a budget prevents new launches without killing existing jobs. Keep the existing hard concurrency caps.

## Non-goals

- [N1] No cgroups, process killing or replacement of host sampling.
- [N2] No quota estimation from load average and no claim that old per-kind thresholds already implement weighted budgets.

## Edge cases this change must handle

1. **Untrusted text** — Validate kind enums and numeric settings; reject unknown quota/profile keys instead of treating them as free work.
2. **Truncated reads** — Partial or capped host/quota reads are unknown, not zero cost or unlimited headroom.
3. **Shared state files** — Atomically reserve and release host-global budgets under a lock; duplicate completion cannot refund twice.
4. **Fail closed** — Unavailable required signals hold the dependent kind; unknown kinds use a conservative heavy profile.
5. **Identity scoping** — Scope model quota by provider/account, GitHub quota by credential identity, and reservations by job/owner; never log credentials.
6. **State over time** — Expire samples, honor quota resets, smooth the symptom brake and reclaim only demonstrably dead reservations.
7. **Who wrote it** — Use trusted sampler and producer observations; caller-provided cost claims cannot bypass classification.

## Grounding

- we:scripts/lib/resource-policy.mjs:19 already declares per-kind policies; line 58 decides from thresholds, not weighted live reservations.
- we:scripts/lib/resource-admission.mjs:40 writes snapshots atomically; line 52 loads platform/tool policy.
- we:scripts/readiness/heavy-admission.mjs:1604 classifies the command and line 1605 acquires before spawning.
- we:scripts/lib/resource-gate.mjs:178 is the shared cutover decision seam.
- Size 13 reflects policy/accounting, new quota sampling, three producer integrations and regression coverage; the original five-point estimate omitted those callers.

## Open questions

Which runtime-settings build and authenticated quota source should this use? Options: reuse the operator’s pending settings/quota work, or build another local settings/quota service. **Pick: reuse the shared work**, but its card/interface was not identifiable in this checkout, so no speculative blockedBy is set. Slice seams: CPU/memory profiles and reservations; model/GitHub quota adapters and callers; symptom brake and runtime overrides. Agree those seams before scheduling the >8-point whole.
