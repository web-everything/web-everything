---
kind: story
size: 8
priority: high
parent: "x6woyws"
status: open
blockedBy: ["x9xkupj"]
scope: ["we:scripts/lib/cost-admission.mjs", "we:scripts/lib/cost-admission-facts.mjs", "we:scripts/lib/__tests__/cost-admission.test.mjs", "we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:scripts/conveyor/tick-core.mjs", "we:scripts/conveyor/__tests__/tick-core-cost-admission.test.mjs", "we:scripts/readiness/heavy-admission.mjs", "we:scripts/readiness/__tests__/heavy-admission.test.mjs", "we:scripts/lib/dispatch-throttle.mjs", "we:scripts/lib/fix-slot-borrow.mjs", "we:scripts/lib/ci-heal-reserve.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Resource service slice 3: cut builder cost admission, light caps and heavy load admission over to admit()

Builder cost admission (we:scripts/lib/cost-admission.mjs admitLaunch, CPU idle floors per kind from we:scripts/dispatch-settings.json cpuIdleMinPct, WE_COST_ADMISSION), the light-launch cap and floor (lightCapFor, WE_MIN_CPU_IDLE_PCT_LIGHT), the fix/ci-heal throttles (we:scripts/lib/dispatch-throttle.mjs, we:scripts/lib/fix-slot-borrow.mjs, we:scripts/lib/ci-heal-reserve.mjs, load per core) and heavy load admission (we:scripts/readiness/heavy-admission.mjs resolveLoadAdmission) decide through admit({kind}) for build, fix, ci-heal, review, prepare and light. The builder-daemon call site was held by PRs #4643/#4658/#4663/#4677 during slice 1, so its shadow call lands here first, then the cut-over. Done when: tests pin each gate's verdict comes from admit(); LIVE proof — a builder tick at high load average but healthy CPU idle launches, with the log naming the admit verdict and the snapshot age.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
