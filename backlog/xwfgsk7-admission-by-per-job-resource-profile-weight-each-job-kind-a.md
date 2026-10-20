---
kind: story
size: 5
status: open
scope: ["we:scripts/readiness/heavy-admission.mjs", "we:scripts/lib/host-overload-settings.mjs", "we:scripts/lib/resource-gate.mjs", "we:scripts/lib/review-seat-settings.mjs", "we:scripts/lib/host-load.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# Admission by per-job resource profile: weight each job kind and admit against its limiting resource (memory, CPU, model quota, GitHub rate)

Admit each job kind against its own limiting resource (memory, CPU, model quota, GitHub rate) using a per-kind resource profile, with load average kept only as a backstop. Follow-up slice to PR #5768 (memory-aware heavy admission). Operator approved 2026-10-20.

## Problem (measured 2026-10-20)

Load average is a poor admission signal.

- At load 52 the CPU was 23% idle. The host was memory-bound, not CPU-bound.
- At load 30 the running set was mostly short-lived git/gh calls.
- Review jobs mostly wait on the model: about 0% CPU, 0.3-0.5 GB RSS each.
- vitest and verify-lane are CPU and memory heavy: 1-2 GB each.
- gh calls are tiny but rate-limited.

Today `we:scripts/readiness/heavy-admission.mjs` counts heavy commands and gates on host load and memory pressure the same way for every kind. Review seats (`we:scripts/lib/review-seat-settings.mjs`) are throttled by a separate concurrency count. Neither knows what each job actually costs.

## Proposal

A per-kind resource profile: cpu weight, memory MB, quota class.

| Kind | CPU weight | Memory | Quota class |
|---|---|---|---|
| verify / vitest | about 4 | about 1500 MB | none |
| review seat | about 0.2 | about 400 MB | model quota |
| red-team seat | similar to review seat | similar | model quota |
| label write | tiny | tiny | GitHub rate |

Admit each kind against ITS limiting resource budget:

- memory headroom, from vm stats / memory_pressure
- CPU idle %
- model quota
- GitHub rate remaining

Add a symptom brake: the rate of git/gh timeouts and pass-duration spikes tightens all budgets. Keep load average only as a backstop.

Profiles and budgets are cascade settings, runtime-settable via the new runtime settings layer (see the runtime settings build). Every admission decision logs its sources (which layer set each value).

## Acceptance

- [A1] **Executable** — one named test per kind (verify/vitest, review seat, red-team seat, label write) proving it is admitted or held against its own limiting resource.
- [A2] **Executable** — a replay of the 2026-10-20 samples shows review seats admitted at load 30 / 10 GB free, and verify held at load 52 / 0.6 GB free.
- [A3] **Executable** — a symptom-brake test: raising the git/gh timeout rate tightens every budget; clearing it restores them.
- [A4] **Executable** — a runtime override of a profile or budget takes effect without restart, and the decision log names the source layer.

## Non-goals

- [N1] No change to the heavy-command capacity cap semantics beyond the new per-kind budgets.
- [N2] No per-process cgroup or container ceiling (separate opt-in path in heavy-admission).
- [N3] No removal of the load-average backstop.

## Edge cases this change must handle

1. **Untrusted text** — n/a: inputs are numeric host samples and settings, not free text.
2. **Truncated reads** — a short or partial vm_stat / memory_pressure read counts as unknown, not as plenty.
3. **Shared state files** — samples and rate counters live in the shared host sampler files; reads tolerate concurrent writers and stale files.
4. **Fail closed** — an unreadable resource signal holds only the kinds that depend on it, with a logged reason; never admits blind.
5. **Identity scoping** — profiles are keyed by job kind, not by caller; one session cannot spend another kind's budget.
6. **State over time** — samples are windowed and smoothed so a fork-storm spike does not flap admission.
7. **Who wrote it** — profile and budget values record which cascade layer (default, file, runtime) set them.

## Links

- PR #5768 (memory-aware heavy admission)
- The runtime settings build (new runtime layer)
- Memory epic xwu9oxh (`we:backlog/6641-memory-audit-cut-per-process-rss-and-duplicated-loads-across.md`)
- Architecture-rules card xglhy4b rule 2 (`we:backlog/6642-standing-architecture-rules-delivery-system.md`)
- `we:scripts/readiness/heavy-admission.mjs`, `we:scripts/lib/host-overload-settings.mjs`, `we:scripts/lib/resource-gate.mjs`, `we:scripts/lib/review-seat-settings.mjs`
