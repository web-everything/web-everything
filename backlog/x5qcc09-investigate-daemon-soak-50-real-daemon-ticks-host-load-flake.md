---
kind: task
status: open
scope: ["we:scripts/conveyor/soak"]
dateOpened: "2026-11-21"
tags: []
---

# Investigate daemon-soak 50 real daemon ticks host-load flake

daemon-soak '50 real daemon ticks' took 696s locally and hit the 17-minute soak timeout under host load. Not a 5s cap; investigate tick cost under load. Source: build-queue 23:43 ET 2026-11-20.

## Acceptance

- [A1] **Executable** — Planned `completes all 50 real daemon ticks under host load before the soak deadline` in `we:scripts/conveyor/soak/daemon-soak.soak.test.mjs`: Run the real daemon soak under the measured host-load fixture; assert exactly 50 completed ticks, record elapsed time from soak start through tick 50 and assert it is within the declared soak deadline. The same probe with the diagnosed tick-cost regression restored must fail the deadline assertion; partial progress or an extended timeout is not passing evidence.

Run `npm run test:unit -- <test-file>` through the host heavy-run queue using the repository-relative path after the `we:` prefix above. These cases are planned; this card does not claim they already pass.

## Non-goals

- [N1] No unexplained timeout increase or assumed 5-second cap.

## Edge cases this change must handle

1. **Untrusted text** — Tick diagnostics remain data.
2. **Truncated reads** — Missing tick timings make the investigation incomplete.
3. **Shared state files** — Isolate soak state from live daemon state.
4. **Fail closed** — Incomplete or timed-out runs remain failures.
5. **Identity scoping** — Attribute timings to the tested daemon run.
6. **State over time** — Compare tick costs throughout the loaded run.
7. **Who wrote it** — Retain measured evidence for the diagnosis.

## Duplicate admission

new-card-from-build-queue-CARD-line --json
