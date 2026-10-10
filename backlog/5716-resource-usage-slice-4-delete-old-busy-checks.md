---
bornAs: xmd6ngm
kind: story
size: 5
priority: high
parent: "5712"
status: open
blockedBy: ["5715"]
scope: ["we:scripts/conveyor/load-flake-reverify.mjs", "we:scripts/lib/daemon-live-smoke.mjs", "we:scripts/lib/cost-admission.mjs", "we:scripts/readiness/heavy-admission.mjs", "we:scripts/lib/dispatch-throttle.mjs", "we:scripts/lib/fix-slot-borrow.mjs", "we:scripts/lib/ci-heal-reserve.mjs", "we:scripts/dispatch-settings.json", "we:scripts/held-cards-io.mjs", "we:scripts/operations/land-advance-io.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Resource service slice 4: delete every gate's own busy check and threshold

Once slices 2 and 3 run on admit(), delete the old per-gate busy checks and their own thresholds and env knobs: WE_LOAD_FLAKE_REVERIFY_MAX_LOAD_PER_CORE, WE_SMOKE_BUSY_LOAD_RATIO and the load-scaled smoke factor, cost admission's cpuIdleMinPct and lightCpuIdleMinPct, heavy admission's WE_LOAD_ADMISSION_* idle/backstop knobs, the load-per-core reads in the dispatch throttles, the quiet-host load1 read in we:scripts/held-cards-io.mjs and the land-advance load gate (we:scripts/operations/land-advance-io.mjs, TODO #3807), plus the shadow logging itself. After this no gate keeps its own threshold: a check:standards rule (or test) refuses a new os.loadavg() admission read outside the sampler. Done when: grep shows no admission decision reads os.loadavg(); tests green; LIVE proof — resource-status and each gate's log agree on one tick.

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
